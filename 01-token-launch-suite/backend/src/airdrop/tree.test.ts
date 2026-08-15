import {describe, expect, it} from 'vitest';
import {AirdropTree, type AirdropEntry} from './tree.js';

/**
 * Fixed entry set shared with the Solidity suite.
 *
 * `contracts/test/AirdropCrossCheck.t.sol` builds a tree from these exact entries with the
 * contract-side library and asserts the same root constant. If the two implementations ever
 * disagree about leaf encoding, pair ordering or odd-node handling, one of the two tests fails.
 *
 * Without this, a mismatch is silent and total: the API serves well-formed proofs and every single
 * claim reverts on-chain with `InvalidProof`.
 */
const SHARED_FIXTURE: AirdropEntry[] = [
  {index: 0, address: '0x0000000000000000000000000000000000000001', amount: 1_000n * 10n ** 18n},
  {index: 1, address: '0x0000000000000000000000000000000000000002', amount: 2_000n * 10n ** 18n},
  {index: 2, address: '0x0000000000000000000000000000000000000003', amount: 3_000n * 10n ** 18n},
  {index: 3, address: '0x0000000000000000000000000000000000000004', amount: 5_000n * 10n ** 18n},
  {index: 4, address: '0x0000000000000000000000000000000000000005', amount: 8_000n * 10n ** 18n},
];

/** Regenerate with `pnpm vitest run -t 'prints the shared fixture root'` if the fixture changes. */
const SHARED_FIXTURE_ROOT = '0x4666c2deeb3c2765955201efa59ccfa4dcd3fcfff11eb56a973c7875382c9273';

describe('AirdropTree', () => {
  it('produces a verifiable proof for every entry', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);

    for (const entry of SHARED_FIXTURE) {
      const proof = tree.proofFor(entry.index);
      expect(proof, `no proof for index ${entry.index}`).not.toBeNull();
      expect(tree.verify(entry, proof!)).toBe(true);
    }
  });

  it('rejects an inflated amount', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);
    const entry = SHARED_FIXTURE[0]!;
    const proof = tree.proofFor(entry.index)!;

    expect(tree.verify({...entry, amount: entry.amount * 1_000n}, proof)).toBe(false);
  });

  it('rejects a proof presented for a different address', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);
    const victim = SHARED_FIXTURE[0]!;
    const attacker = SHARED_FIXTURE[1]!;
    const proof = tree.proofFor(victim.index)!;

    expect(tree.verify({...victim, address: attacker.address}, proof)).toBe(false);
  });

  it('rejects a proof used under a different index', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);
    const entry = SHARED_FIXTURE[2]!;
    const proof = tree.proofFor(entry.index)!;

    // Reusing a valid proof under another index would break the claim bitmap's one-claim guarantee.
    expect(tree.verify({...entry, index: 4}, proof)).toBe(false);
  });

  it('rejects duplicate indices', () => {
    expect(
      () =>
        new AirdropTree([
          SHARED_FIXTURE[0]!,
          {...SHARED_FIXTURE[1]!, index: 0},
        ]),
    ).toThrow(/duplicate index/);
  });

  /** Two leaves for one wallet would let it claim twice, since the bitmap keys on index. */
  it('rejects duplicate addresses', () => {
    expect(
      () =>
        new AirdropTree([
          SHARED_FIXTURE[0]!,
          {...SHARED_FIXTURE[1]!, address: SHARED_FIXTURE[0]!.address},
        ]),
    ).toThrow(/duplicate address/);
  });

  it('is independent of input ordering', () => {
    const forwards = new AirdropTree(SHARED_FIXTURE);
    const backwards = new AirdropTree([...SHARED_FIXTURE].reverse());

    expect(backwards.root).toBe(forwards.root);
  });

  it('handles a single entry, where the root is the leaf', () => {
    const only = SHARED_FIXTURE[0]!;
    const tree = new AirdropTree([only]);

    expect(tree.root).toBe(AirdropTree.leafFor(only));
    expect(tree.proofFor(only.index)).toEqual([]);
  });

  it('handles an odd entry count, where the last node is promoted', () => {
    const odd = SHARED_FIXTURE.slice(0, 3);
    const tree = new AirdropTree(odd);

    for (const entry of odd) {
      expect(tree.verify(entry, tree.proofFor(entry.index)!)).toBe(true);
    }
  });

  it('reports the total allocation', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);
    expect(tree.totalAmount).toBe(19_000n * 10n ** 18n);
    expect(tree.size).toBe(5);
  });

  it('rejects an empty entry list', () => {
    expect(() => new AirdropTree([])).toThrow(/no entries/);
  });

  it('matches the root the Solidity suite asserts', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);
    expect(tree.root).toBe(SHARED_FIXTURE_ROOT);
  });

  it('prints the shared fixture root', () => {
    const tree = new AirdropTree(SHARED_FIXTURE);
    console.log(`SHARED_FIXTURE_ROOT = ${tree.root}`);
    expect(tree.root).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
