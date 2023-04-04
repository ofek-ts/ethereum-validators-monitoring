import { Module } from '@nestjs/common';

import { ConsensusProviderModule } from 'common/eth-providers';
import { RegistryModule } from 'common/validators-registry';
import { ClickhouseModule } from 'storage/clickhouse';

import { SummaryModule } from '../summary';
import { WithdrawalsMetrics } from './withdrawals.metrics';
import { WithdrawalsService } from './withdrawals.service';

@Module({
  imports: [RegistryModule, ConsensusProviderModule, ClickhouseModule, SummaryModule],
  providers: [WithdrawalsService, WithdrawalsMetrics],
  exports: [WithdrawalsService, WithdrawalsMetrics],
})
export class WithdrawalsModule {}
