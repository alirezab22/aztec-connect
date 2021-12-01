import { AssetId } from '@aztec/barretenberg/asset';
import { toBufferBE } from '@aztec/barretenberg/bigint_buffer';
import { numToUInt32BE } from '@aztec/barretenberg/serialize';
import { NoteAlgorithms } from '@aztec/barretenberg/note_algorithms';
import { WorldStateDb } from '@aztec/barretenberg/world_state_db';
import { randomBytes } from 'crypto';
import moment from 'moment';
import { PipelineCoordinator } from '.';
import { ClaimProofCreator } from '../claim_proof_creator';
import { TxDao } from '../entity/tx';
import { RollupAggregator } from '../rollup_aggregator';
import { RollupCreator } from '../rollup_creator';
import { RollupDb } from '../rollup_db';
import { RollupPublisher } from '../rollup_publisher';
import { TxFeeResolver } from '../tx_fee_resolver';
import { TxType } from '@aztec/barretenberg/blockchain';

type Mockify<T> = {
  [P in keyof T]: jest.Mock;
};

describe('pipeline_coordinator', () => {
  const numInnerRollupTxs = 2;
  const numOuterRollupProofs = 4;
  const publishInterval = moment.duration(10, 's');
  let rollupCreator: Mockify<RollupCreator>;
  let rollupAggregator: Mockify<RollupAggregator>;
  let rollupPublisher: Mockify<RollupPublisher>;
  let claimProofCreator: Mockify<ClaimProofCreator>;
  let rollupDb: Mockify<RollupDb>;
  let worldStateDb: Mockify<WorldStateDb>;
  let noteAlgo: Mockify<NoteAlgorithms>;
  let feeResolver: Mockify<TxFeeResolver>;
  let coordinator: PipelineCoordinator;

  const mockRollup = () => ({ id: 0, interactionResult: Buffer.alloc(0), mined: moment() });

  const mockTx = (created = moment()) =>
    ({
      proofData: Buffer.concat([
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
        Buffer.alloc(32),
        randomBytes(64),
        randomBytes(64),
        randomBytes(32),
        toBufferBE(100000n, 32),
        numToUInt32BE(AssetId.ETH, 32),
        randomBytes(32),
        randomBytes(32),
      ]),
      created: created.toDate(),
      txType: TxType.TRANSFER,
    } as TxDao);

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => 1618226000000);

    jest.spyOn(console, 'log').mockImplementation(() => {});

    rollupCreator = {
      create: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      interrupt: jest.fn(),
    };

    rollupAggregator = {
      aggregateRollupProofs: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      interrupt: jest.fn(),
    };

    rollupPublisher = {
      publishRollup: jest.fn().mockResolvedValue(true),
      interrupt: jest.fn(),
      getRollupBenificiary: jest.fn(),
    };

    claimProofCreator = {
      create: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      interrupt: jest.fn(),
    };

    worldStateDb = {
      getRoot: jest.fn().mockResolvedValue(Buffer.alloc(32)),
      getHashPath: jest.fn(),
    } as any;

    rollupDb = {
      deleteUnsettledRollups: jest.fn(),
      deleteOrphanedRollupProofs: jest.fn(),
      deleteUnsettledClaimTxs: jest.fn(),
      getLastSettledRollup: jest.fn().mockResolvedValue(undefined),
      getPendingTxs: jest.fn().mockResolvedValue([]),
    } as any;

    feeResolver = {
      getBaseTxGas: jest.fn().mockReturnValue(1),
      getGasPaidForByFee: jest.fn().mockImplementation((assetId: AssetId, fee: bigint) => fee),
      getMinTxFee: jest.fn().mockImplementation(() => {
        throw new Error('This should not be called');
      }),
      start: jest.fn(),
      stop: jest.fn(),
      getFeeQuotes: jest.fn(),
      computeSurplusRatio: jest.fn().mockImplementation(() => {
        throw new Error('This should not be called');
      }),
      getTxGas: jest.fn().mockImplementation((assetId: AssetId, txType: TxType) => {
        if (txType === TxType.DEFI_DEPOSIT) {
          throw new Error('This should not be called');
        }
        return 1n;
      }),
    };

    noteAlgo = {
      commitDefiInteractionNote: jest.fn(),
    } as any;

    coordinator = new PipelineCoordinator(
      rollupCreator as any,
      rollupAggregator as any,
      rollupPublisher as any,
      claimProofCreator as any,
      feeResolver as any,
      worldStateDb as any,
      rollupDb as any,
      noteAlgo as any,
      numInnerRollupTxs,
      numOuterRollupProofs,
      publishInterval,
      [],
    );
  });

  it('should publish a rollup', async () => {
    rollupDb.getPendingTxs.mockImplementation(() => [mockTx(moment().subtract(publishInterval))]);
    await coordinator.start();
    expect(rollupPublisher.publishRollup).toHaveBeenCalledTimes(1);
  });

  it('should continue to process pending txs until publish', async () => {
    rollupDb.getLastSettledRollup.mockImplementation(() => mockRollup());
    rollupDb.getPendingTxs.mockImplementation(() => [mockTx(), mockTx()]);
    await coordinator.start();
    expect(rollupPublisher.publishRollup).toHaveBeenCalledTimes(1);
  });

  it('should return publishInterval seconds from now if not running', async () => {
    expect(coordinator.getNextPublishTime().baseTimeout?.timeout).toEqual(moment().add(10, 's').toDate());
    coordinator.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    coordinator.stop();
    expect(coordinator.getNextPublishTime().baseTimeout?.timeout).toEqual(moment().add(10, 's').toDate());
  });

  it('cannot start when it has already started', async () => {
    const p = coordinator.start();
    await expect(async () => coordinator.start()).rejects.toThrow();
    coordinator.stop();
    await p;
  });

  it('should interrupt all helpers when it is stop', async () => {
    coordinator.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    coordinator.stop();
    expect(rollupCreator.interrupt).toHaveBeenCalledTimes(1);
    expect(rollupAggregator.interrupt).toHaveBeenCalledTimes(1);
    expect(rollupPublisher.interrupt).toHaveBeenCalledTimes(1);
  });
});