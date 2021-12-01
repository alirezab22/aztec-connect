import { EthAddress } from '@aztec/barretenberg/address';
import { AssetId } from '@aztec/barretenberg/asset';
import { Asset, EthereumProvider, PriceFeed, SendTxOptions, TypedData } from '@aztec/barretenberg/blockchain';
import { TxHash } from '@aztec/barretenberg/tx_hash';
import { Web3Provider } from '@ethersproject/providers';
import { Web3Signer } from '../signer';
import { EthAsset, TokenAsset } from './asset';
import { FeeDistributor } from './fee_distributor';
import { EthPriceFeed, GasPriceFeed, TokenPriceFeed } from './price_feed';
import { RollupProcessor } from './rollup_processor';

/**
 * Facade around all Aztec smart contract classes.
 * Provides a factory function `fromAddresses` to simplify construction of all contract classes.
 * Exposes a more holistic interface to clients, than having to deal with individual contract classes.
 */
export class Contracts {
  private provider!: Web3Provider;

  constructor(
    private rollupProcessor: RollupProcessor,
    private feeDistributor: FeeDistributor,
    private assets: Asset[],
    private gasPriceFeed: GasPriceFeed,
    private priceFeeds: PriceFeed[],
    private ethereumProvider: EthereumProvider,
    private confirmations: number,
  ) {
    this.provider = new Web3Provider(ethereumProvider);
  }

  static async fromAddresses(
    rollupContractAddress: EthAddress,
    feeDistributorAddress: EthAddress,
    priceFeedContractAddresses: EthAddress[],
    ethereumProvider: EthereumProvider,
    confirmations: number,
  ) {
    const rollupProcessor = new RollupProcessor(rollupContractAddress, ethereumProvider);

    const feeDistributor = new FeeDistributor(feeDistributorAddress, ethereumProvider);

    const assetAddresses = await rollupProcessor.getSupportedAssets();
    const tokenAssets = await Promise.all(
      assetAddresses
        .slice(1)
        .map(async (addr, i) =>
          TokenAsset.fromAddress(
            addr,
            ethereumProvider,
            await rollupProcessor.getAssetPermitSupport(i + 1),
            confirmations,
          ),
        ),
    );
    const assets = [new EthAsset(ethereumProvider), ...tokenAssets];

    const [gasPriceFeedAddress, ...tokenPriceFeedAddresses] = priceFeedContractAddresses;
    const gasPriceFeed = new GasPriceFeed(gasPriceFeedAddress, ethereumProvider);
    const priceFeeds = [
      new EthPriceFeed(),
      ...tokenPriceFeedAddresses.map(a => new TokenPriceFeed(a, ethereumProvider)),
    ];

    return new Contracts(
      rollupProcessor,
      feeDistributor,
      assets,
      gasPriceFeed,
      priceFeeds,
      ethereumProvider,
      confirmations,
    );
  }

  public async setSupportedAsset(assetAddress: EthAddress, supportsPermit: boolean, options: SendTxOptions = {}) {
    const tx = await this.rollupProcessor.setSupportedAsset(assetAddress, supportsPermit, options);
    const tokenAsset = await TokenAsset.fromAddress(assetAddress, this.ethereumProvider, supportsPermit);
    this.assets.push(tokenAsset);
    return tx;
  }

  public async getPerRollupState() {
    const defiInteractionHashes = await this.rollupProcessor.defiInteractionHashes();

    return {
      defiInteractionHashes,
    };
  }

  public async getPerBlockState() {
    const { escapeOpen, blocksRemaining } = await this.rollupProcessor.getEscapeHatchStatus();

    return {
      escapeOpen,
      numEscapeBlocksRemaining: blocksRemaining,
    };
  }

  public getRollupBalance(assetId: number) {
    return this.assets[assetId].balanceOf(this.rollupProcessor.address);
  }

  public getFeeDistributorBalance(assetId: number) {
    return this.assets[assetId].balanceOf(this.feeDistributor.address);
  }

  public getRollupContractAddress() {
    return this.rollupProcessor.address;
  }

  public getFeeDistributorContractAddress() {
    return this.feeDistributor.address;
  }

  public async getVerifierContractAddress() {
    return this.rollupProcessor.verifier();
  }

  public async createEscapeHatchProofTx(proofData: Buffer, signatures: Buffer[], offchainTxData: Buffer[]) {
    return this.rollupProcessor.createEscapeHatchProofTx(proofData, signatures, offchainTxData);
  }

  public async createRollupProofTx(proofData: Buffer, signatures: Buffer[], offchainTxData: Buffer[]) {
    return this.rollupProcessor.createRollupProofTx(proofData, signatures, offchainTxData);
  }

  public async sendTx(data: Buffer, options: SendTxOptions = {}) {
    return this.rollupProcessor.sendTx(data, options);
  }

  public async estimateGas(data: Buffer) {
    const signer = this.provider.getSigner(0);
    const from = await signer.getAddress();
    const txRequest = {
      to: this.rollupProcessor.address.toString(),
      from,
      data,
    };
    const estimate = await this.provider.estimateGas(txRequest);
    return estimate.toNumber();
  }

  public async getRollupBlocksFrom(rollupId: number, minConfirmations = this.confirmations) {
    return this.rollupProcessor.getRollupBlocksFrom(rollupId, minConfirmations);
  }

  public async getRollupBlock(rollupId: number) {
    return this.rollupProcessor.getRollupBlock(rollupId);
  }

  public async getUserPendingDeposit(assetId: AssetId, account: EthAddress) {
    return this.rollupProcessor.getUserPendingDeposit(assetId, account);
  }

  public async getTransactionReceipt(txHash: TxHash) {
    return this.provider.getTransactionReceipt(txHash.toString());
  }

  public async getChainId() {
    const { chainId } = await this.provider.getNetwork();
    return chainId;
  }

  public async getBlockNumber() {
    return this.provider.getBlockNumber();
  }

  public async signPersonalMessage(message: Buffer, address: EthAddress) {
    const signer = new Web3Signer(this.ethereumProvider);
    return signer.signPersonalMessage(message, address);
  }

  public async signMessage(message: Buffer, address: EthAddress) {
    const signer = new Web3Signer(this.ethereumProvider);
    return signer.signMessage(message, address);
  }

  public async signTypedData(data: TypedData, address: EthAddress) {
    const signer = new Web3Signer(this.ethereumProvider);
    return signer.signTypedData(data, address);
  }

  public getAssets() {
    return this.assets;
  }

  public getAsset(assetId: AssetId) {
    return this.assets[assetId];
  }

  public async getAssetPrice(assetId: AssetId) {
    return this.priceFeeds[assetId].price();
  }

  public getPriceFeed(assetId: AssetId) {
    return this.priceFeeds[assetId];
  }

  public getGasPriceFeed() {
    return this.gasPriceFeed;
  }

  public async getUserProofApprovalStatus(address: EthAddress, txId: Buffer) {
    return this.rollupProcessor.getProofApprovalStatus(address, txId);
  }

  public async isContract(address: EthAddress) {
    return (await this.provider.getCode(address.toString())) !== '0x';
  }
}