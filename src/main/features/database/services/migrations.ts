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
    // Skip migration for fresh installs (lastVersion is default '0.0.0')
    if (lastVersion !== '0.0.0' && semver.lte(lastVersion, '3.6.0') && semver.gt(currentVersion, '3.6.0')) {
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
    const games = Object.entries(allLocal)
    
    log.info(`[Migrations] Checking ${games.length} games for orphaned entries`)

    // Check all games in parallel for better performance
    const validationResults = await Promise.all(
      games.map(async ([gameId, doc]) => {
        const isValid = await isValidGame(gameId, doc)
        return { gameId, isValid }
      })
    )

    // Collect games to remove
    const gamesToRemove = validationResults
      .filter(result => !result.isValid)
      .map(result => result.gameId)

    log.info(`[Migrations] Found ${gamesToRemove.length} orphaned games`)

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

/**
 * Check if a game has a valid monitor path
 * Returns false for games that should be removed
 */
async function isValidGame(gameId: string, doc: any): Promise<boolean> {
  try {
    // Check if launcher mode exists
    const mode = doc.launcher?.mode
    if (!mode) {
      log.warn(`[Migrations] Game ${gameId} has no launcher mode`)
      return false
    }

    // Check if mode config exists
    const modeConfig = doc.launcher[`${mode}Config`]
    const monitorPath = modeConfig?.monitorPath

    if (!monitorPath) {
      log.warn(`[Migrations] Game ${gameId} has no monitor path`)
      return false
    }

    // Check if the monitor path exists asynchronously
    try {
      await fs.promises.access(monitorPath)
      return true
    } catch {
      log.info(`[Migrations] Game ${gameId} has invalid path: ${monitorPath}`)
      return false
    }
  } catch (error) {
    log.warn(`[Migrations] Error validating game ${gameId}:`, error)
    return false
  }
}
