import { GameDBManager, ConfigDBManager } from '~/core/database'
import { app } from 'electron'
import semver from 'semver'
import log from 'electron-log/main'
import * as fs from 'fs'

/**
 * Run database migrations based on app version
 * This should be called after database initialization but before other services
 */
export async function runMigrations(): Promise<void> {
  try {
    const currentVersion = app.getVersion() // e.g., '4.6.0'
    const lastVersion = (await ConfigDBManager.getConfigValue('app.lastVersion')) || '0.0.0'

    log.info(`[Migrations] Running migrations - Last version: ${lastVersion}, Current: ${currentVersion}`)

    // Run version-specific migrations
    if (semver.lte(lastVersion, '3.6.0') && semver.gt(currentVersion, '3.6.0')) {
      log.info('[Migrations] Detected upgrade from version <= 3.6.0, running zombie game cleanup')
      await cleanupZombieGames()
    }

    // Update stored version
    await ConfigDBManager.setConfigValue('app.lastVersion', currentVersion)
    log.info('[Migrations] Migrations completed successfully')
  } catch (error) {
    log.error('[Migrations] Migration failed:', error)
    // Don't throw - allow app to continue even if migration fails
  }
}

/**
 * Clean up orphaned games from versions <= 3.6.0
 * 
 * In versions <= 3.6.0, there was a bug where deleted games could leave
 * zombie monitor entries. This function detects and removes games with
 * invalid or missing monitor paths.
 */
async function cleanupZombieGames(): Promise<void> {
  try {
    const allLocal = await GameDBManager.getAllGamesLocal()
    const gamesToRemove: string[] = []
    let checkedCount = 0

    for (const [gameId, doc] of Object.entries(allLocal)) {
      checkedCount++
      try {
        // Get the monitor path for this game
        const mode = doc.launcher?.mode
        if (!mode) {
          log.warn(`[Migrations] Game ${gameId} has no launcher mode, marking for cleanup`)
          gamesToRemove.push(gameId)
          continue
        }

        const modeConfig = doc.launcher[`${mode}Config`]
        const monitorPath = modeConfig?.monitorPath

        if (!monitorPath) {
          log.warn(`[Migrations] Game ${gameId} has no monitor path, marking for cleanup`)
          gamesToRemove.push(gameId)
          continue
        }

        // Check if the monitor path exists
        if (!fs.existsSync(monitorPath)) {
          log.info(`[Migrations] Game ${gameId} has invalid path: ${monitorPath}, marking for cleanup`)
          gamesToRemove.push(gameId)
          continue
        }
      } catch (error) {
        log.warn(`[Migrations] Error checking game ${gameId}, marking for cleanup:`, error)
        gamesToRemove.push(gameId)
      }
    }

    log.info(`[Migrations] Checked ${checkedCount} games, found ${gamesToRemove.length} orphaned games`)

    // Remove orphaned games
    for (const gameId of gamesToRemove) {
      try {
        await GameDBManager.removeGame(gameId)
        log.info(`[Migrations] Removed orphaned game: ${gameId}`)
      } catch (error) {
        log.error(`[Migrations] Failed to remove orphaned game ${gameId}:`, error)
      }
    }

    if (gamesToRemove.length > 0) {
      log.info(`[Migrations] Zombie game cleanup completed: removed ${gamesToRemove.length} orphaned games`)
    } else {
      log.info('[Migrations] No orphaned games found')
    }
  } catch (error) {
    log.error('[Migrations] Zombie game cleanup failed:', error)
  }
}
