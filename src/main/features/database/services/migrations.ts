import log from 'electron-log/main'
import { GameDBManager } from '~/core/database'
import { gameDoc, gameLocalDoc } from '@appTypes/models'

/**
 * Run all database migrations
 */
export async function runMigrations(): Promise<void> {
  try {
    log.info('[Migrations] Starting database migrations...')
    await cleanupZombieGames()
    log.info('[Migrations] Database migrations completed')
  } catch (error) {
    log.error('[Migrations] Error running migrations:', error)
    throw error
  }
}

/**
 * Remove invalid games from the database
 * A game is considered invalid if:
 * - It has no monitor path AND
 * - It has never been played (no play history or user data)
 */
async function cleanupZombieGames(): Promise<void> {
  try {
    log.info('[Migrations] Starting cleanup of invalid games...')

    const allGames = await GameDBManager.getAllGames()
    const allLocalGames = await GameDBManager.getAllGamesLocal()

    let removedCount = 0

    for (const gameId in allGames) {
      const game = allGames[gameId]
      const localGame = allLocalGames[gameId]

      // Skip if local game data doesn't exist
      if (!localGame) {
        log.warn(`[Migrations] Game ${gameId} has no local data, skipping...`)
        continue
      }

      const isValid = await isValidGame(gameId, { game, localGame })

      if (!isValid) {
        log.info(`[Migrations] Removing invalid game: ${gameId} (${game.metadata.name})`)
        await GameDBManager.removeGame(gameId)
        await GameDBManager.removeGameLocal(gameId)
        removedCount++
      }
    }

    log.info(`[Migrations] Cleanup completed. Removed ${removedCount} invalid game(s)`)
  } catch (error) {
    log.error('[Migrations] Error during zombie game cleanup:', error)
    throw error
  }
}

async function isValidGame(gameId: string, doc: any): Promise<boolean> {
  try {
    // Check if launcher mode exists
    const game = doc.game as gameDoc
    const localGame = doc.localGame as gameLocalDoc

    if (!localGame || !localGame.launcher) {
      log.warn(`[Migrations] Game ${gameId} has invalid launcher config`)
      return false
    }

    const mode = localGame.launcher.mode
    const modeConfig = localGame.launcher[`${mode}Config`]

    if (!modeConfig) {
      log.warn(`[Migrations] Game ${gameId} has no ${mode}Config`)
      return false
    }

    // Get the monitor path
    const monitorPath = modeConfig.monitorPath

    // If the game has a valid monitor path, it's valid
    if (monitorPath && monitorPath.trim() !== '') {
      return true
    }

    // If no monitor path, check if the game has play history or user data
    // A game with play history or user data should not be removed even without monitor path
    const record = game.record

    if (!record) {
      // No record means this is a truly zombie game with no setup
      return false
    }

    // Check if the game has been played:
    // 1. Has last run date
    if (record.lastRunDate && record.lastRunDate.trim() !== '') {
      log.info(`[Migrations] Game ${gameId} has no monitor path but has play history (lastRunDate)`)
      return true
    }

    // 2. Has play time
    if (record.playTime && record.playTime > 0) {
      log.info(
        `[Migrations] Game ${gameId} has no monitor path but has play history (playTime: ${record.playTime})`
      )
      return true
    }

    // 3. Has a play status other than 'unplayed'
    if (record.playStatus && record.playStatus !== 'unplayed') {
      log.info(
        `[Migrations] Game ${gameId} has no monitor path but has play history (status: ${record.playStatus})`
      )
      return true
    }

    // 4. Has timers recorded
    if (record.timers && record.timers.length > 0) {
      log.info(`[Migrations] Game ${gameId} has no monitor path but has play history (timers)`)
      return true
    }

    // 5. Has a score set (not the default -1)
    if (record.score !== undefined && record.score !== -1) {
      log.info(
        `[Migrations] Game ${gameId} has no monitor path but has user data (score: ${record.score})`
      )
      return true
    }

    // 6. Has save files
    if (game.save && game.save.saveList && Object.keys(game.save.saveList).length > 0) {
      log.info(`[Migrations] Game ${gameId} has no monitor path but has user data (saves)`)
      return true
    }

    // 7. Has memories
    if (game.memory && game.memory.memoryList && Object.keys(game.memory.memoryList).length > 0) {
      log.info(`[Migrations] Game ${gameId} has no monitor path but has user data (memories)`)
      return true
    }

    // Game has no monitor path and no play history or user data - it's invalid
    log.info(
      `[Migrations] Game ${gameId} has no monitor path and no play history - marking as invalid`
    )
    return false
  } catch (error) {
    log.error(`[Migrations] Error checking validity of game ${gameId}:`, error)
    // In case of error, preserve the game to be safe
    return true
  }
}
