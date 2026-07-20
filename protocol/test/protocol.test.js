const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const THRESHOLD = E(50_000);
const SUPPLY = E(1_000_000_000);          // Bags mints 1e9 with 18 decimals
const GOLD_PER_WETH = E(1);               // keeps the arithmetic checkable by hand

describe("Gold protocol (Bags launch model)", function () {
  async function deploy() {
    const [owner, alice, bob, carol, dave, keeper, pool] = await ethers.getSigners();

    const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
    const gold = await (await ethers.getContractFactory("MockGLD")).deploy();

    // Bags deploys the token. It is a plain ERC-20 with NO hook back into the
    // distributor, which is the whole reason eligibility is keeper-driven.
    const token = await (await ethers.getContractFactory("MockBagsToken"))
      .deploy(owner.address, SUPPLY);

    const dist = await (await ethers.getContractFactory("GoldDistributor")).deploy(
      await token.getAddress(), await gold.getAddress(), THRESHOLD, owner.address
    );
    const treasury = await (await ethers.getContractFactory("GoldTreasury")).deploy(
      await weth.getAddress(), await gold.getAddress(), await dist.getAddress(), owner.address
    );
    const router = await (await ethers.getContractFactory("MockRouter")).deploy(
      await weth.getAddress(), await gold.getAddress(), GOLD_PER_WETH
    );
    const feeShare = await (await ethers.getContractFactory("MockBagsFeeShare")).deploy(
      await weth.getAddress(), await treasury.getAddress()
    );

    await dist.setTreasury(await treasury.getAddress());
    await treasury.setRouter(await router.getAddress());
    await treasury.setFeeShare(await feeShare.getAddress());
    await treasury.setKeeper(keeper.address, true);

    await dist.setExcluded(owner.address, true);   // deployer float never earns
    await dist.setExcluded(pool.address, true);    // nor the market maker

    return { owner, alice, bob, carol, dave, keeper, pool, weth, gold, token, dist, treasury, router, feeShare };
  }

  /**
   * Transfer, then tell the distributor about it.
   *
   * In production the keeper does this by reading Transfer events since the last
   * cycle and resyncing only the addresses that actually moved. The Bags token
   * cannot notify the distributor itself, so nothing updates without this.
   */
  async function move(token, dist, from, to, amount) {
    const toAddr = to.address ?? to;
    await token.connect(from).transfer(toAddr, amount);
    await dist.resync([from.address, toAddr]);
  }

  /** Fees accrue in the Bags fee-share contract, get claimed, then converted. */
  async function feeCycle({ weth, feeShare, treasury, keeper }, wethAmount) {
    await weth.mint(await feeShare.getAddress(), wethAmount);
    await treasury.claimFees();
    return treasury.connect(keeper).convertAndDistribute(0, 0);
  }

  describe("eligibility without a cooperative token", function () {
    it("tracks eligibility purely from keeper-driven resync", async function () {
      const { owner, alice, bob, dist, token } = await loadFixture(deploy);

      await move(token, dist, owner, alice, THRESHOLD);
      await move(token, dist, owner, bob, THRESHOLD - 1n);

      expect(await dist.isEligible(alice.address)).to.equal(true);
      expect(await dist.isEligible(bob.address)).to.equal(false);
      expect(await dist.eligibleSupply()).to.equal(THRESHOLD);
    });

    it("does NOT see a transfer until someone resyncs (the keeper's real job)", async function () {
      const { owner, alice, dist, token } = await loadFixture(deploy);

      await token.transfer(alice.address, E(100_000)); // deliberately no resync
      expect(await dist.isEligible(alice.address)).to.equal(false);
      expect(await dist.eligibleSupply()).to.equal(0n);

      await dist.resync([alice.address]);
      expect(await dist.isEligible(alice.address)).to.equal(true);
      expect(await dist.eligibleSupply()).to.equal(E(100_000));
    });

    it("adds and removes wallets as balances cross the line", async function () {
      const { owner, alice, bob, dist, token } = await loadFixture(deploy);

      await move(token, dist, owner, alice, E(100_000));
      await move(token, dist, owner, bob, E(100_000));
      expect(await dist.eligibleCount()).to.equal(2);

      await move(token, dist, alice, bob, E(75_000));   // alice -> 25k, under
      expect(await dist.isEligible(alice.address)).to.equal(false);
      expect(await dist.eligibleSupply()).to.equal(E(175_000));

      await move(token, dist, bob, alice, E(75_000));   // back over
      expect(await dist.isEligible(alice.address)).to.equal(true);
      expect(await dist.eligibleSupply()).to.equal(E(200_000));
    });

    it("excludes the deployer float and the pool", async function () {
      const { owner, pool, dist, token } = await loadFixture(deploy);
      await move(token, dist, owner, pool, E(250_000_000));
      expect(await dist.eligibleSupply()).to.equal(0n);
    });
  });

  describe("fee flow through Bags", function () {
    it("claims WETH out of the BagsFeeShare contract", async function () {
      const { weth, feeShare, treasury } = await loadFixture(deploy);

      await weth.mint(await feeShare.getAddress(), E(5));
      expect(await weth.balanceOf(await treasury.getAddress())).to.equal(0n);

      await treasury.claimFees();

      expect(await weth.balanceOf(await treasury.getAddress())).to.equal(E(5));
      expect(await treasury.totalWethClaimed()).to.equal(E(5));
    });

    it("lets anyone claim — fees keep flowing if every keeper dies", async function () {
      const { weth, feeShare, treasury, dave } = await loadFixture(deploy);
      await weth.mint(await feeShare.getAddress(), E(2));
      await expect(treasury.connect(dave).claimFees()).to.not.be.reverted;
      expect(await weth.balanceOf(await treasury.getAddress())).to.equal(E(2));
    });

    it("also accepts WETH forwarded from a wallet claimer", async function () {
      // The fallback path if Bags will not accept a contract as a fee claimer.
      const { weth, treasury, keeper, dist, token, owner, alice } = await loadFixture(deploy);
      await move(token, dist, owner, alice, E(100_000));

      await weth.mint(keeper.address, E(3));
      await weth.connect(keeper).transfer(await treasury.getAddress(), E(3));
      await treasury.connect(keeper).convertAndDistribute(0, 0);

      expect(await dist.owed(alice.address)).to.equal(E(3));
    });

    it("credits what actually arrived, not what the router claimed", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, dist, token, router, treasury } = ctx;
      await move(token, dist, owner, alice, E(100_000));

      await router.setSkimBps(1000); // router quietly keeps 10%
      await feeCycle(ctx, E(10));

      expect(await dist.owed(alice.address)).to.equal(E(9));
      expect(await treasury.totalGoldDistributed()).to.equal(E(9));
    });

    it("reverts rather than accept a bad price", async function () {
      const { weth, feeShare, treasury, keeper } = await loadFixture(deploy);
      await weth.mint(await feeShare.getAddress(), E(1));
      await treasury.claimFees();
      await expect(
        treasury.connect(keeper).convertAndDistribute(E(1), E(2))
      ).to.be.revertedWithCustomError(await ethers.getContractFactory("MockRouter"), "Slippage");
    });

    it("leaves no standing router allowance after a swap", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, dist, token, weth, treasury, router } = ctx;
      await move(token, dist, owner, alice, E(100_000));
      await feeCycle(ctx, E(5));

      expect(await weth.allowance(await treasury.getAddress(), await router.getAddress())).to.equal(0n);
    });

    it("has no owner path to withdraw the gold or the WETH", async function () {
      const { owner, treasury, gold, weth } = await loadFixture(deploy);
      for (const t of [gold, weth]) {
        await expect(
          treasury.connect(owner).rescueToken(await t.getAddress(), owner.address, 1)
        ).to.be.revertedWithCustomError(treasury, "NotRescuable");
      }
    });
  });

  describe("distribution maths", function () {
    it("splits a cycle pro-rata", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, bob, dist, token } = ctx;

      await move(token, dist, owner, alice, E(150_000)); // 75%
      await move(token, dist, owner, bob, E(50_000));    // 25%
      await feeCycle(ctx, E(4));

      expect(await dist.owed(alice.address)).to.equal(E(3));
      expect(await dist.owed(bob.address)).to.equal(E(1));
    });

    it("pays nothing for cycles that happened before you bought", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, bob, dist, token } = ctx;

      await move(token, dist, owner, alice, E(50_000));
      await feeCycle(ctx, E(2));

      await move(token, dist, owner, bob, E(50_000));
      expect(await dist.owed(bob.address)).to.equal(0n);

      await feeCycle(ctx, E(2));
      expect(await dist.owed(alice.address)).to.equal(E(3));
      expect(await dist.owed(bob.address)).to.equal(E(1));
    });

    it("stops accrual below the threshold but never claws back", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, bob, dist, token } = ctx;

      await move(token, dist, owner, alice, E(50_000));
      await move(token, dist, owner, bob, E(50_000));
      await feeCycle(ctx, E(2));

      await move(token, dist, alice, bob, E(25_000)); // alice now under
      await feeCycle(ctx, E(2));

      expect(await dist.owed(alice.address)).to.equal(E(1));
      const bobOwed = await dist.owed(bob.address);
      expect(bobOwed).to.be.lessThanOrEqual(E(3));
      expect(E(3) - bobOwed).to.be.lessThan(10n);
    });

    it("carries gold forward when nobody qualifies yet", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, dist, token } = ctx;

      await feeCycle(ctx, E(5));
      expect(await dist.carry()).to.equal(E(5));
      expect(await dist.cycles()).to.equal(0n);

      await move(token, dist, owner, alice, E(50_000));
      await feeCycle(ctx, E(1));

      expect(await dist.owed(alice.address)).to.equal(E(6));
      expect(await dist.carry()).to.equal(0n);
    });

    // REGRESSION: distribute() used to floor per cycle while owed() floors once
    // over the accumulated total. Because sum(floor(x)) <= floor(sum(x)) the
    // promise drifted above the reserve and pushBatch eventually reverted paying
    // the last holder. distribute() now rounds consumed UP. Invariant: held >= owed.
    it("stays solvent across many awkward cycles (regression)", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, bob, carol, dist, token, gold, keeper } = ctx;

      await move(token, dist, owner, alice, E(50_000));
      await move(token, dist, owner, bob, E(50_005));
      await move(token, dist, owner, carol, E(166_665));

      let sent = 0n;
      for (let i = 1; i <= 25; i++) {
        const amt = BigInt(i) * 7n + 13n;
        await feeCycle(ctx, amt);
        sent += amt;
      }

      const owed = (await dist.owed(alice.address)) + (await dist.owed(bob.address)) + (await dist.owed(carol.address));
      const held = await gold.balanceOf(await dist.getAddress());

      expect(held).to.equal(sent);
      expect(owed + (await dist.carry())).to.be.lessThanOrEqual(held);
      await expect(dist.connect(keeper).pushBatch(0, 100)).to.not.be.reverted;
      expect(await dist.owed(carol.address)).to.equal(0n);
    });
  });

  describe("payout", function () {
    it("pushes gold to holders without them doing anything", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, bob, keeper, dist, token, gold } = ctx;

      await move(token, dist, owner, alice, E(150_000));
      await move(token, dist, owner, bob, E(50_000));
      await feeCycle(ctx, E(4));

      await dist.connect(keeper).pushBatch(0, 100);
      expect(await gold.balanceOf(alice.address)).to.equal(E(3));
      expect(await gold.balanceOf(bob.address)).to.equal(E(1));
    });

    it("lets a holder claim for themselves if no keeper runs", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, dist, token, gold } = ctx;

      await move(token, dist, owner, alice, E(50_000));
      await feeCycle(ctx, E(2));

      await dist.connect(alice).claim();
      expect(await gold.balanceOf(alice.address)).to.equal(E(2));
    });

    it("never double-pays across overlapping batches and claims", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, keeper, dist, token, gold } = ctx;

      await move(token, dist, owner, alice, E(50_000));
      await feeCycle(ctx, E(2));

      await dist.connect(keeper).pushBatch(0, 100);
      await dist.connect(keeper).pushBatch(0, 100);
      await dist.connect(alice).claim();

      expect(await gold.balanceOf(alice.address)).to.equal(E(2));
    });

    it("resumes correctly when a batch is paged", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, keeper, dist, token, gold } = ctx;
      const wallets = (await ethers.getSigners()).slice(10, 20);

      for (const w of wallets) await move(token, dist, owner, w, E(50_000));
      await feeCycle(ctx, E(10));

      await dist.connect(keeper).pushBatch(0, 4);
      await dist.connect(keeper).pushBatch(4, 4);
      await dist.connect(keeper).pushBatch(8, 4);

      for (const w of wallets) expect(await gold.balanceOf(w.address)).to.equal(E(1));
    });
  });

  describe("access control", function () {
    it("only the treasury may credit a distribution", async function () {
      const { alice, dist } = await loadFixture(deploy);
      await expect(dist.connect(alice).distribute(1)).to.be.revertedWithCustomError(dist, "NotTreasury");
    });

    it("only a keeper may convert", async function () {
      const { alice, treasury } = await loadFixture(deploy);
      await expect(
        treasury.connect(alice).convertAndDistribute(0, 0)
      ).to.be.revertedWithCustomError(treasury, "NotKeeper");
    });

    it("refuses to claim before the Bags fee-share address is set", async function () {
      const { weth, gold, dist, owner } = await loadFixture(deploy);
      const fresh = await (await ethers.getContractFactory("GoldTreasury")).deploy(
        await weth.getAddress(), await gold.getAddress(), await dist.getAddress(), owner.address
      );
      await expect(fresh.claimFees()).to.be.revertedWithCustomError(fresh, "FeeShareNotSet");
    });
  });

  describe("economic safety", function () {
    it("splitting a balance across many wallets earns exactly the same", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, dist, token } = ctx;
      const sybils = (await ethers.getSigners()).slice(10, 15);

      await move(token, dist, owner, alice, E(250_000));
      for (const s of sybils) await move(token, dist, owner, s, E(50_000));

      await feeCycle(ctx, E(2)); // 500k eligible, alice holds half

      let sybilTotal = 0n;
      for (const s of sybils) sybilTotal += await dist.owed(s.address);

      expect(await dist.owed(alice.address)).to.equal(E(1));
      expect(sybilTotal).to.equal(E(1));
    });

    it("a wallet transferring to itself cannot inflate its share", async function () {
      const ctx = await loadFixture(deploy);
      const { owner, alice, dist, token } = ctx;

      await move(token, dist, owner, alice, E(50_000));
      await move(token, dist, alice, alice, E(25_000));
      expect(await dist.eligibleSupply()).to.equal(E(50_000));

      await feeCycle(ctx, E(1));
      expect(await dist.owed(alice.address)).to.equal(E(1));
    });
  });
});
