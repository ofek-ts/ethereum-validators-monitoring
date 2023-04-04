import { BigNumber } from '@ethersproject/bignumber';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { batch } from 'stream-json/utils/Batch';

import { ConfigService } from 'common/config';
import { ConsensusProviderService, StateValidatorResponse, ValStatus } from 'common/eth-providers';
import { Epoch, Slot } from 'common/eth-providers/consensus-provider/types';
import { bigNumberSqrt } from 'common/functions/bigNumberSqrt';
import { unblock } from 'common/functions/unblock';
import { PrometheusService, TrackTask } from 'common/prometheus';
import { RegistryService } from 'common/validators-registry';
import { ClickhouseService } from 'storage/clickhouse';

import { SummaryService } from '../summary';

@Injectable()
export class StateService {
  public constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly clClient: ConsensusProviderService,
    protected readonly summary: SummaryService,
    protected readonly storage: ClickhouseService,
    protected readonly registry: RegistryService,
  ) {}

  @TrackTask('check-state-duties')
  public async check(epoch: Epoch, stateSlot: Slot): Promise<void> {
    const slotTime = await this.clClient.getSlotTime(epoch * this.config.get('FETCH_INTERVAL_SLOTS'));
    await this.registry.updateKeysRegistry(Number(slotTime));
    this.logger.log('Getting all validators state');
    const readStream = await this.clClient.getValidatorsState(stateSlot);
    this.logger.log('Processing all validators state');
    let activeValidatorsCount = 0;
    let activeValidatorsEffectiveBalance = 0n;
    const pipeline = chain([readStream, parser(), pick({ filter: 'data' }), streamArray(), batch({ batchSize: 1000 })]);
    pipeline.on('data', async (batch) => {
      for (const data of batch) {
        const state: StateValidatorResponse = data.value;
        const index = Number(state.index);
        const operator = this.registry.getOperatorKey(state.validator.pubkey);
        this.summary.epoch(epoch).set({
          epoch,
          val_id: index,
          val_pubkey: state.validator.pubkey,
          val_nos_id: operator?.operatorIndex,
          val_nos_name: operator?.operatorName,
          val_slashed: state.validator.slashed,
          val_status: state.status,
          val_balance: BigInt(state.balance),
          val_effective_balance: BigInt(state.validator.effective_balance),
        });
        if ([ValStatus.ActiveOngoing, ValStatus.ActiveExiting, ValStatus.ActiveSlashed].includes(state.status)) {
          activeValidatorsCount++;
          activeValidatorsEffectiveBalance += BigInt(state.validator.effective_balance) / BigInt(10 ** 9);
        }
      }
      await unblock();
    });
    await new Promise((resolve, reject) => {
      pipeline.on('error', (error) => reject(error));
      pipeline.on('end', () => resolve(true));
    }).finally(() => pipeline.destroy());
    const baseReward = Math.trunc(
      BigNumber.from(64 * 10 ** 9)
        .div(bigNumberSqrt(BigNumber.from(activeValidatorsEffectiveBalance).mul(10 ** 9)))
        .toNumber(),
    );
    this.summary.epoch(epoch).setMeta({
      state: {
        active_validators: activeValidatorsCount,
        active_validators_total_increments: activeValidatorsEffectiveBalance,
        base_reward: baseReward,
      },
    });
  }
}
