import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { RegistryOperator } from '@lido-nestjs/registry';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { ConfigService } from 'common/config';
import { Epoch } from 'common/eth-providers/consensus-provider/types';
import { Owner, PrometheusService, PrometheusValStatus, TrackTask, setUserOperatorsMetric } from 'common/prometheus';
import { RegistryService, RegistrySourceOperator } from 'common/validators-registry';
import { LidoSourceService } from 'common/validators-registry/lido-source';
import { ClickhouseService } from 'storage/clickhouse';

const GWEI_WEI_RATIO = 1e9;
const ETH_GWEI_RATIO = 1e9;

@Injectable()
export class StateMetrics {
  protected processedEpoch: number;
  protected operators: RegistrySourceOperator[];
  public constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly registryService: RegistryService,
    protected readonly storage: ClickhouseService,
  ) {}

  @TrackTask('calc-state-metrics')
  public async calculate(epoch: Epoch) {
    this.logger.log('Calculating state metrics');
    this.processedEpoch = epoch;
    this.operators = await this.registryService.getOperators();
    await Promise.all([
      this.operatorsIdentifies(),
      this.nosStats(),
      this.userValidatorsStats(),
      this.otherValidatorsStats(),
      this.avgDeltas(),
      this.minDeltas(),
      this.negativeValidatorsCount(),
      this.totalBalance24hDifference(),
      this.operatorBalance24hDifference(),
      this.contract(),
    ]);
  }

  private async operatorsIdentifies() {
    setUserOperatorsMetric(
      this.prometheus.operatorsIdentifies,
      this.operators.map((operator) => ({ val_nos_id: operator.index, amount: 1 })),
      this.operators,
      (o) => ({ nos_id: o.index, nos_name: o.name }),
    );
  }

  private async nosStats() {
    const data = await this.storage.getUserNodeOperatorsStats(this.processedEpoch);
    setUserOperatorsMetric(
      this.prometheus.userValidators,
      data,
      this.operators,
      {
        status: PrometheusValStatus.Slashed,
      },
      (item) => item.slashed,
    );
    setUserOperatorsMetric(
      this.prometheus.userValidators,
      data,
      this.operators,
      {
        status: PrometheusValStatus.Ongoing,
      },
      (item) => item.active_ongoing,
    );
    setUserOperatorsMetric(
      this.prometheus.userValidators,
      data,
      this.operators,
      {
        status: PrometheusValStatus.Pending,
      },
      (item) => item.pending,
    );
    setUserOperatorsMetric(
      this.prometheus.userValidators,
      data,
      this.operators,
      {
        status: PrometheusValStatus.WithdrawalPending,
      },
      (item) => item.withdraw_pending,
    );
    setUserOperatorsMetric(
      this.prometheus.userValidators,
      data,
      this.operators,
      {
        status: PrometheusValStatus.WithdrawalDone,
      },
      (item) => item.withdrawn,
    );
  }

  private async userValidatorsStats() {
    const result = await this.storage.getUserValidatorsSummaryStats(this.processedEpoch);
    this.logger.debug(`User stats: ${JSON.stringify(result)}`);
    this.prometheus.validators.set(
      {
        owner: Owner.USER,
        status: PrometheusValStatus.Slashed,
      },
      result.slashed,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.USER,
        status: PrometheusValStatus.Ongoing,
      },
      result.active_ongoing,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.USER,
        status: PrometheusValStatus.Pending,
      },
      result.pending,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.USER,
        status: PrometheusValStatus.WithdrawalPending,
      },
      result.withdraw_pending,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.USER,
        status: PrometheusValStatus.WithdrawalDone,
      },
      result.withdrawn,
    );
  }

  private async otherValidatorsStats() {
    const result = await this.storage.getOtherValidatorsSummaryStats(this.processedEpoch);
    this.logger.debug(`Other stats: ${JSON.stringify(result)}`);
    this.prometheus.validators.set(
      {
        owner: Owner.OTHER,
        status: PrometheusValStatus.Ongoing,
      },
      result.active_ongoing,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.OTHER,
        status: PrometheusValStatus.Pending,
      },
      result.pending,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.OTHER,
        status: PrometheusValStatus.Slashed,
      },
      result.slashed,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.OTHER,
        status: PrometheusValStatus.WithdrawalPending,
      },
      result.withdraw_pending,
    );
    this.prometheus.validators.set(
      {
        owner: Owner.OTHER,
        status: PrometheusValStatus.WithdrawalDone,
      },
      result.withdrawn,
    );
  }

  private async avgDeltas() {
    const data = await this.storage.getAvgValidatorBalanceDelta(this.processedEpoch);
    setUserOperatorsMetric(this.prometheus.avgValidatorBalanceDelta, data, this.operators);
  }

  private async minDeltas() {
    const data = await this.storage.getValidatorQuantile0001BalanceDeltas(this.processedEpoch);
    setUserOperatorsMetric(this.prometheus.validatorQuantile001BalanceDelta, data, this.operators);
  }

  private async negativeValidatorsCount() {
    const data = await this.storage.getValidatorsCountWithNegativeDelta(this.processedEpoch);
    setUserOperatorsMetric(this.prometheus.validatorsCountWithNegativeBalanceDelta, data, this.operators);
  }

  private async totalBalance24hDifference() {
    const result = await this.storage.getTotalBalance24hDifference(this.processedEpoch);
    if (result) this.prometheus.totalBalance24hDifference.set(result);
  }

  private async operatorBalance24hDifference() {
    const data = await this.storage.getOperatorBalance24hDifference(this.processedEpoch);
    setUserOperatorsMetric(this.prometheus.operatorBalance24hDifference, data, this.operators);
  }

  private async contract() {
    if (!(this.registryService.source instanceof LidoSourceService)) return;
    this.prometheus.contractKeysTotal.set(
      { type: 'total' },
      this.operators.reduce((sum, o: RegistryOperator) => sum + o.totalSigningKeys, 0),
    );
    this.prometheus.contractKeysTotal.set(
      { type: 'used' },
      this.operators.reduce((sum, o: RegistryOperator) => sum + o.usedSigningKeys, 0),
    );
    const bufferedEther = (await this.registryService.source.contract.getBufferedEther()).div(GWEI_WEI_RATIO).div(ETH_GWEI_RATIO);
    this.prometheus.bufferedEther.set(bufferedEther.toNumber());
  }
}
