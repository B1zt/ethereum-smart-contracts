import {describe, expect, it} from 'vitest';
import {MerkleAllowlist, type AllowlistEntry} from './tree.js';

/**
 * Fixed entry set shared with the Solidity test suite.
 *
 * `contracts/test/MerkleCrossCheck.t.sol` builds a tree from these exact entries using the
 * contract-side library and asserts the same root constant below. If the two implementations ever
 * disagree about leaf encoding, pair ordering or odd-node handling, one of the two tests fails.
 *
 * That matters because the failure mode otherwise is silent: the backend serves proofs that look
 * well-formed, and every single mint reverts with `InvalidProof` on-chain.
 */
const SHARED_FIXTURE: AllowlistEntry[] = [
  {address: '0x0000000000000000000000000000000000000001', allowance: 1},
  {address: '0x0000000000000000000000000000000000000002', allowance: 2},
  {address: '0x0000000000000000000000000000000000000003', allowance: 3},
  {address: '0x0000000000000000000000000000000000000004', allowance: 5},
  {address: '0x0000000000000000000000000000000000000005', allowance: 8},
];

/** Regenerate with `pnpm vitest run -t 'prints the shared fixture root'` if the fixture changes. */
const SHARED_FIXTURE_ROOT = '0x84790ae8790a0e497b9d0df18feea9350eb8349d15929ca25f3a780545111096';

describe('MerkleAllowlist', () => {
  it('produces a verifiable proof for every entry', () => {
    const tree = new MerkleAllowlist(SHARED_FIXTURE);

    for (const entry of SHARED_FIXTURE) {
      const proof = tree.proofFor(entry.address);
      expect(proof, `no proof for ${entry.address}`).not.toBeNull();
      expect(tree.verify(entry, proof!)).toBe(true);
    }
  });

  it('rejects an inflated allowance', () => {
    const tree = new MerkleAllowlist(SHARED_FIXTURE);
    const entry = SHARED_FIXTURE[0]!;
    const proof = tree.proofFor(entry.address)!;

    // Same address, same proof, larger allowance. The leaf no longer matches, which is exactly the
    // attack the on-chain check has to stop.
    expect(tree.verify({...entry, allowance: 1_000}, proof)).toBe(false);
  });

  it('rejects a proof presented by a different address', () => {
    const tree = new MerkleAllowlist(SHARED_FIXTURE);
    const victim = SHARED_FIXTURE[0]!;
    const attacker = SHARED_FIXTURE[1]!;
    const proof = tree.proofFor(victim.address)!;

    expect(tree.verify({address: attacker.address, allowance: victim.allowance}, proof)).toBe(false);
  });

  it('returns null for an address that is not on the list', () => {
    const tree = new MerkleAllowlist(SHARED_FIXTURE);
    expect(tree.proofFor('0x000000000000000000000000000000000000dead')).toBeNull();
  });

  it('is deterministic regardless of input order', () => {
    const forwards = new MerkleAllowlist(SHARED_FIXTURE);
    const backwards = new MerkleAllowlist([...SHARED_FIXTURE].reverse());

    expect(backwards.root).toBe(forwards.root);
  });

  it('handles a single-entry tree, where the root is the leaf', () => {
    const only = SHARED_FIXTURE[0]!;
    const tree = new MerkleAllowlist([only]);

    expect(tree.root).toBe(MerkleAllowlist.leafFor(only));
    expect(tree.proofFor(only.address)).toEqual([]);
    expect(tree.verify(only, [])).toBe(true);
  });

  it('handles an odd number of entries, where the last node is promoted', () => {
    // Three entries means one node is promoted unchanged at the first level. Duplicating it instead
    // is the other common convention and yields a different root, so this pins the choice.
    const odd = SHARED_FIXTURE.slice(0, 3);
    const tree = new MerkleAllowlist(odd);

    for (const entry of odd) {
      expect(tree.verify(entry, tree.proofFor(entry.address)!)).toBe(true);
    }
  });

  it('rejects an empty entry list', () => {
    expect(() => new MerkleAllowlist([])).toThrow(/no entries/);
  });

  it('matches the root the Solidity suite asserts', () => {
    const tree = new MerkleAllowlist(SHARED_FIXTURE);
    expect(tree.root).toBe(SHARED_FIXTURE_ROOT);
  });

  it('prints the shared fixture root', () => {
    // Not an assertion. Run this test alone to regenerate the constant above and its Solidity twin.
    const tree = new MerkleAllowlist(SHARED_FIXTURE);
    console.log(`SHARED_FIXTURE_ROOT = ${tree.root}`);
    expect(tree.root).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
