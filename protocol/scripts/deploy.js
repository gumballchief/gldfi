const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E = (n) => ethers.parseEther(String(n));

/**
 * Local deployment of the Bags launch model.
 *
 * In production Bags deploys the token, the bonding curve and the fee-share
 * contract; Gold only deploys the distributor and the treasury and then
 * points them at the Bags addresses. MockBagsToken / MockBagsFeeShare / MockWETH
 * / MockRouter stand in for those here so the whole loop runs locally.
 */
async function main() {
  const [deployer, keeper] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log(`network : ${net.name} (chainId ${net.chainId})`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`keeper  : ${keeper.address}\n`);

  const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
  const gold = await (await ethers.getContractFactory("MockGLD")).deploy();
  await weth.waitForDeployment(); await gold.waitForDeployment();
  console.log("MockWETH          ", await weth.getAddress());
  console.log("MockGLD (gold)    ", await gold.getAddress());

  // Bags mints this in production: 1e9 supply, 18 decimals.
  const token = await (await ethers.getContractFactory("MockBagsToken"))
    .deploy(deployer.address, E(1_000_000_000));
  await token.waitForDeployment();
  console.log("MockBagsToken     ", await token.getAddress());

  const dist = await (await ethers.getContractFactory("GoldDistributor")).deploy(
    await token.getAddress(), await gold.getAddress(), E(50_000), deployer.address
  );
  await dist.waitForDeployment();
  console.log("GoldDistributor  ", await dist.getAddress());

  const treasury = await (await ethers.getContractFactory("GoldTreasury")).deploy(
    await weth.getAddress(), await gold.getAddress(), await dist.getAddress(), deployer.address
  );
  await treasury.waitForDeployment();
  console.log("GoldTreasury     ", await treasury.getAddress());

  const router = await (await ethers.getContractFactory("MockRouter")).deploy(
    await weth.getAddress(), await gold.getAddress(), E(1)
  );
  await router.waitForDeployment();
  console.log("MockRouter        ", await router.getAddress());

  // The treasury is the registered fee claimer — the trustless route.
  const feeShare = await (await ethers.getContractFactory("MockBagsFeeShare")).deploy(
    await weth.getAddress(), await treasury.getAddress()
  );
  await feeShare.waitForDeployment();
  console.log("MockBagsFeeShare  ", await feeShare.getAddress());

  await (await dist.setTreasury(await treasury.getAddress())).wait();
  await (await treasury.setRouter(await router.getAddress())).wait();
  await (await treasury.setFeeShare(await feeShare.getAddress())).wait();
  await (await treasury.setKeeper(keeper.address, true)).wait();
  await (await dist.setExcluded(deployer.address, true)).wait();

  console.log("\nwired: BagsFeeShare -> treasury -> router -> distributor");
  console.log("threshold:", ethers.formatEther(await dist.threshold()), "Gold");

  const out = {
    chainId: Number(net.chainId),
    deployer: deployer.address,
    keeper: keeper.address,
    contracts: {
      GoldDistributor: await dist.getAddress(),
      GoldTreasury: await treasury.getAddress(),
      GoldToken: await token.getAddress(),      // Bags token in production
      WETH: await weth.getAddress(),
      Gold: await gold.getAddress(),
      Router: await router.getAddress(),
      BagsFeeShare: await feeShare.getAddress(),
    },
    params: { totalSupply: "1000000000", threshold: "50000", creatorFeeBps: 100, intervalSeconds: 900 },
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net.chainId}.json`), JSON.stringify(out, null, 2));
  console.log(`\naddresses written to deployments/${net.chainId}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
