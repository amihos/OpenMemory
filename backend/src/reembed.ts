#!/usr/bin/env node
/**
 * Re-embed Migration Script
 *
 * This script re-embeds all memories using the current embedding configuration.
 * Use this when:
 * - Upgrading embedding models (e.g., embedding-001 -> text-embedding-004)
 * - Changing embedding dimensions
 * - Fixing corrupted embeddings
 *
 * Usage:
 *   npx ts-node src/reembed.ts [--dry-run] [--batch-size=N] [--delay-ms=N]
 *
 * Options:
 *   --dry-run       Show what would be done without making changes
 *   --batch-size=N  Process N memories at a time (default: 10)
 *   --delay-ms=N    Delay between batches in ms (default: 1000)
 *   --user-id=X     Only re-embed memories for specific user
 */

import { q, all_async, transaction } from "./core/db";
import {
    embedMultiSector,
    vectorToBuffer,
    EmbeddingResult,
} from "./memory/embed";
import {
    classify_content,
    calc_mean_vec,
} from "./memory/hsg";
import { chunk_text } from "./utils/chunking";
import { env, tier } from "./core/cfg";

interface Memory {
    id: string;
    content: string;
    primary_sector: string;
    user_id: string | null;
    meta: string;
    created_at: number;
}

interface ReembedStats {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    errors: Array<{ id: string; error: string }>;
}

async function get_all_memories(user_id?: string): Promise<Memory[]> {
    if (user_id) {
        return await q.all_mem_by_user.all(user_id, 100000, 0);
    }
    return await q.all_mem.all(100000, 0);
}

async function reembed_memory(
    mem: Memory,
    dry_run: boolean
): Promise<{ success: boolean; error?: string }> {
    try {
        const metadata = mem.meta ? JSON.parse(mem.meta) : {};
        const classification = classify_content(mem.content, metadata);
        const all_sectors = [classification.primary, ...classification.additional];

        const chunks = chunk_text(mem.content);
        const use_chunking = chunks.length > 1;

        if (dry_run) {
            console.log(`  [DRY-RUN] Would re-embed memory ${mem.id}`);
            console.log(`    Content: ${mem.content.slice(0, 100)}...`);
            console.log(`    Sectors: ${all_sectors.join(", ")}`);
            console.log(`    Chunks: ${chunks.length}`);
            return { success: true };
        }

        // Generate new embeddings
        const emb_res = await embedMultiSector(
            mem.id,
            mem.content,
            all_sectors,
            use_chunking ? chunks : undefined
        );

        // Delete old vectors and insert new ones
        await q.del_vec.run(mem.id);

        for (const result of emb_res) {
            const vec_buf = vectorToBuffer(result.vector);
            await q.ins_vec.run(
                mem.id,
                result.sector,
                mem.user_id || null,
                vec_buf,
                result.dim
            );
        }

        // Update mean vector
        const mean_vec = calc_mean_vec(emb_res, all_sectors);
        const mean_vec_buf = vectorToBuffer(mean_vec);
        await q.upd_mean_vec.run(mem.id, mean_vec.length, mean_vec_buf);

        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
}

async function run_reembed(options: {
    dry_run: boolean;
    batch_size: number;
    delay_ms: number;
    user_id?: string;
}): Promise<ReembedStats> {
    const stats: ReembedStats = {
        total: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        errors: [],
    };

    console.log("[REEMBED] Starting re-embedding migration...");
    console.log(`[REEMBED] Configuration:`);
    console.log(`  Tier: ${tier}`);
    console.log(`  Embedding kind: ${env.emb_kind}`);
    console.log(`  Vector dimension: ${env.vec_dim}`);
    console.log(`  Batch size: ${options.batch_size}`);
    console.log(`  Delay between batches: ${options.delay_ms}ms`);
    console.log(`  Dry run: ${options.dry_run}`);
    if (options.user_id) {
        console.log(`  User ID filter: ${options.user_id}`);
    }
    console.log("");

    // Get all memories
    const memories = await get_all_memories(options.user_id);
    stats.total = memories.length;

    console.log(`[REEMBED] Found ${stats.total} memories to process`);

    if (stats.total === 0) {
        console.log("[REEMBED] No memories to process");
        return stats;
    }

    // Process in batches
    for (let i = 0; i < memories.length; i += options.batch_size) {
        const batch = memories.slice(i, i + options.batch_size);
        const batch_num = Math.floor(i / options.batch_size) + 1;
        const total_batches = Math.ceil(memories.length / options.batch_size);

        console.log(`[REEMBED] Processing batch ${batch_num}/${total_batches} (${batch.length} memories)`);

        for (const mem of batch) {
            stats.processed++;
            const result = await reembed_memory(mem, options.dry_run);

            if (result.success) {
                stats.succeeded++;
                if (!options.dry_run) {
                    console.log(`  ✓ ${mem.id.slice(0, 8)} - ${mem.content.slice(0, 50)}...`);
                }
            } else {
                stats.failed++;
                stats.errors.push({ id: mem.id, error: result.error || "Unknown error" });
                console.error(`  ✗ ${mem.id.slice(0, 8)} - ${result.error}`);
            }
        }

        // Delay between batches to avoid rate limiting
        if (i + options.batch_size < memories.length && options.delay_ms > 0) {
            await new Promise(resolve => setTimeout(resolve, options.delay_ms));
        }
    }

    console.log("");
    console.log("[REEMBED] Migration complete!");
    console.log(`[REEMBED] Results:`);
    console.log(`  Total: ${stats.total}`);
    console.log(`  Processed: ${stats.processed}`);
    console.log(`  Succeeded: ${stats.succeeded}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log(`  Skipped: ${stats.skipped}`);

    if (stats.errors.length > 0) {
        console.log("");
        console.log("[REEMBED] Errors:");
        for (const err of stats.errors.slice(0, 10)) {
            console.log(`  - ${err.id}: ${err.error}`);
        }
        if (stats.errors.length > 10) {
            console.log(`  ... and ${stats.errors.length - 10} more errors`);
        }
    }

    return stats;
}

// Parse command line arguments
function parse_args(): {
    dry_run: boolean;
    batch_size: number;
    delay_ms: number;
    user_id?: string;
} {
    const args = process.argv.slice(2);
    const options = {
        dry_run: false,
        batch_size: 10,
        delay_ms: 1000,
        user_id: undefined as string | undefined,
    };

    for (const arg of args) {
        if (arg === "--dry-run") {
            options.dry_run = true;
        } else if (arg.startsWith("--batch-size=")) {
            options.batch_size = parseInt(arg.split("=")[1], 10);
        } else if (arg.startsWith("--delay-ms=")) {
            options.delay_ms = parseInt(arg.split("=")[1], 10);
        } else if (arg.startsWith("--user-id=")) {
            options.user_id = arg.split("=")[1];
        } else if (arg === "--help" || arg === "-h") {
            console.log(`
Re-embed Migration Script

Usage:
  npx ts-node src/reembed.ts [options]

Options:
  --dry-run         Show what would be done without making changes
  --batch-size=N    Process N memories at a time (default: 10)
  --delay-ms=N      Delay between batches in ms (default: 1000)
  --user-id=X       Only re-embed memories for specific user
  --help, -h        Show this help message
`);
            process.exit(0);
        }
    }

    return options;
}

// Main execution
const options = parse_args();
run_reembed(options)
    .then((stats) => {
        if (stats.failed > 0) {
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error("[REEMBED] Fatal error:", err);
        process.exit(1);
    });
