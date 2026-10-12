/**
 * SDK Metadata Extractor
 * Captures available tools and slash commands from Claude SDK initialization
 */

import { query } from './query'
import type { SDKSystemMessage } from './types'
import {
    isCacheableMetadata,
    readCachedSDKMetadata,
    resolveSDKMetadataCacheKey,
    type SDKMetadata,
    writeCachedSDKMetadata,
} from './metadataCache'
import { getDefaultClaudeCodePath } from './utils'
import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable'
import { logger } from '@/ui/logger'
import { resolveClaudeSessionEnvOverlay } from '../spawn/resolveClaudeSessionEnvOverlay'

export type { SDKMetadata } from './metadataCache'

/**
 * Extract SDK metadata by running a minimal query and capturing the init message
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(options?: Readonly<{ claudeCodeIncludeInNativeHistory?: boolean }>): Promise<SDKMetadata> {
    const abortController = new AbortController()

    try {
        logger.debug('[metadataExtractor] Starting SDK metadata extraction')
        const runtimeExecutable = await ensureClaudeJsRuntimeExecutable()
        const claudePath = getDefaultClaudeCodePath()
        const env = resolveClaudeSessionEnvOverlay(options ?? {})
        const cacheKey = resolveSDKMetadataCacheKey({ claudePath, runtimeExecutable, entrypoint: env.CLAUDE_CODE_ENTRYPOINT })
        const cached = cacheKey ? readCachedSDKMetadata(cacheKey) : null
        if (cached) {
            logger.debug('[metadataExtractor] Using cached SDK metadata:', cached)
            return cached
        }

        // Run SDK with minimal tools allowed
        const sdkQuery = query({
            prompt: 'hello',
            options: {
                maxTurns: 1,
                extraArgs: ['--no-session-persistence'],
                env,
                executable: runtimeExecutable,
                pathToClaudeCodeExecutable: claudePath,
                abort: abortController.signal
            }
        })

        // Wait for the first system message which contains tools and slash commands
        for await (const message of sdkQuery) {
            if (message.type === 'system' && message.subtype === 'init') {
                const systemMessage = message as SDKSystemMessage

                const metadata: SDKMetadata = {}
                if (Array.isArray(systemMessage.tools)) metadata.tools = systemMessage.tools
                if (Array.isArray(systemMessage.slash_commands)) metadata.slashCommands = systemMessage.slash_commands

                logger.debug('[metadataExtractor] Captured SDK metadata:', metadata)

                // Abort the query since we got what we need
                abortController.abort()

                if (cacheKey && isCacheableMetadata(metadata)) {
                    await writeCachedSDKMetadata(cacheKey, metadata)
                }

                return metadata
            }
        }

        logger.debug('[metadataExtractor] No init message received from SDK')
        return {}

    } catch (error) {
        // Check if it's an abort error (expected)
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('[metadataExtractor] SDK query aborted after capturing metadata')
            return {}
        }
        logger.debug('[metadataExtractor] Error extracting SDK metadata:', error)
        return {}
    }
}

/**
 * Extract SDK metadata asynchronously without blocking
 * Fires the extraction and updates metadata when complete
 */
export function extractSDKMetadataAsync(onComplete: (metadata: SDKMetadata) => void, options?: Readonly<{ claudeCodeIncludeInNativeHistory?: boolean }>): void {
    extractSDKMetadata(options)
        .then(metadata => {
            if (metadata.tools || metadata.slashCommands) {
                onComplete(metadata)
            }
        })
        .catch(error => {
            logger.debug('[metadataExtractor] Async extraction failed:', error)
        })
}
