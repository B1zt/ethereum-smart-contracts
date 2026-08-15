import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {prisma} from '../lib/prisma.js';
import {MerkleAllowlist, type AllowlistEntry} from './tree.js';

const createSchema = z.object({
  collection: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  phaseId: z.number().int().nonnegative(),
  entries: z
    .array(
      z.object({
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        allowance: z.number().int().positive().max(65_535),
      }),
    )
    .min(1)
    .max(100_000),
});

/**
 * Rebuild the tree from stored entries.
 *
 * Only the entries are persisted, never the tree itself. A tree is a pure function of its entries,
 * so storing it would be a second source of truth that can drift. Rebuilding is fast enough to do
 * per request at these list sizes, and a cache in front of the proof endpoint handles the rest.
 */
async function loadTree(collection: string, phaseId: number) {
  const allowlist = await prisma.allowlist.findUnique({
    where: {collection_phaseId: {collection: collection.toLowerCase(), phaseId}},
    include: {entries: true},
  });

  if (!allowlist) return null;

  const entries: AllowlistEntry[] = allowlist.entries.map((entry) => ({
    address: entry.address as `0x${string}`,
    allowance: entry.allowance,
  }));

  return {allowlist, tree: new MerkleAllowlist(entries)};
}

export async function merkleRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Build an allowlist and return its root.
   *
   * In production this sits behind admin auth: publishing a root is a privileged action, and the
   * root returned here is what the collection owner then writes on-chain via `addPhase`.
   */
  app.post('/allowlists', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_BODY', issues: parsed.error.issues});
    }

    const {collection, phaseId, entries} = parsed.data;

    const normalised: AllowlistEntry[] = entries.map((entry) => ({
      address: entry.address.toLowerCase() as `0x${string}`,
      allowance: entry.allowance,
    }));

    // A duplicate address would produce two leaves for one wallet, and only one of them would ever
    // be reachable by the proof endpoint. Reject rather than silently pick a winner.
    const seen = new Set<string>();
    for (const entry of normalised) {
      if (seen.has(entry.address)) {
        return reply.status(400).send({error: 'DUPLICATE_ADDRESS', address: entry.address});
      }
      seen.add(entry.address);
    }

    const tree = new MerkleAllowlist(normalised);

    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.allowlist.upsert({
        where: {collection_phaseId: {collection: collection.toLowerCase(), phaseId}},
        create: {collection: collection.toLowerCase(), phaseId, root: tree.root},
        update: {root: tree.root},
      });

      // Replacing an allowlist replaces it wholesale. Merging would leave stale entries that no
      // longer match the published root.
      await tx.allowlistEntry.deleteMany({where: {allowlistId: created.id}});
      await tx.allowlistEntry.createMany({
        data: normalised.map((entry, index) => ({
          allowlistId: created.id,
          address: entry.address,
          allowance: entry.allowance,
          leafIndex: index,
        })),
      });

      return created;
    });

    return reply.status(201).send({
      allowlist: {id: record.id, collection: record.collection, phaseId, root: tree.root},
      entryCount: normalised.length,
      // The collection owner writes this root into the phase config on-chain.
      nextStep: 'Call addPhase(...) on the collection with this merkleRoot',
    });
  });

  /**
   * Proof for one wallet in one phase.
   *
   * This is the endpoint the mint page calls. A 404 means "not on the list", which the UI renders
   * as an ineligible state rather than an error.
   */
  app.get('/allowlists/:collection/:phaseId/proof/:address', async (request, reply) => {
    const params = request.params as {collection: string; phaseId: string; address: string};
    const phaseId = Number(params.phaseId);

    if (!Number.isInteger(phaseId) || phaseId < 0) {
      return reply.status(400).send({error: 'INVALID_PHASE_ID'});
    }

    const loaded = await loadTree(params.collection, phaseId);
    if (!loaded) {
      return reply.status(404).send({error: 'ALLOWLIST_NOT_FOUND'});
    }

    const entry = loaded.allowlist.entries.find(
      (candidate) => candidate.address === params.address.toLowerCase(),
    );

    if (!entry) {
      return reply.status(404).send({error: 'NOT_ELIGIBLE', root: loaded.allowlist.root});
    }

    const proof = loaded.tree.proofFor(entry.address);
    if (!proof) {
      return reply.status(404).send({error: 'NOT_ELIGIBLE', root: loaded.allowlist.root});
    }

    return reply.send({
      address: entry.address,
      allowance: entry.allowance,
      proof,
      root: loaded.tree.root,
    });
  });

  /** Root and size, for verifying the on-chain phase config matches this list. */
  app.get('/allowlists/:collection/:phaseId', async (request, reply) => {
    const params = request.params as {collection: string; phaseId: string};
    const phaseId = Number(params.phaseId);

    const loaded = await loadTree(params.collection, phaseId);
    if (!loaded) {
      return reply.status(404).send({error: 'ALLOWLIST_NOT_FOUND'});
    }

    return reply.send({
      collection: loaded.allowlist.collection,
      phaseId,
      root: loaded.tree.root,
      entryCount: loaded.allowlist.entries.length,
    });
  });
}
