import type { EnvironmentConfig } from '../types.js'
import type { Driver } from './driver.js'
import { MssqlDriver } from './mssql.js'
import { MysqlDriver } from './mysql.js'
import { PostgresDriver } from './postgres.js'

export function createDriver(env: EnvironmentConfig): Driver {
  switch (env.driver) {
    case 'postgres': return new PostgresDriver(env)
    case 'mysql': return new MysqlDriver(env)
    case 'mssql': return new MssqlDriver(env)
  }
}
export type { Driver } from './driver.js'
