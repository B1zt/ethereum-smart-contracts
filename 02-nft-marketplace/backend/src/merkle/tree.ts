import {concatHex, encodeAbiParameters, keccak256, type Hex} from 'viem';

export interface AllowlistEntry {
  address: `0x${string}`;
  allowance: number;
}

/**
 * Merkle allowlist, built to match the contract's verification exactly.
 *
 * Three details have to line up with `Collection721._verifyEligibility`, and getting any of them
 * wrong produces a tree that looks fine locally and fails every on-chain proof:
 *
 *   1. **Leaf encoding** is `keccak256(keccak256(abi.encode(address, allowance)))`. The double hash
 *      is what stops a 64-byte internal node from being passed off as a leaf, which would otherwise
 *      let an attacker forge membership from a published proof.
 *
 *   2. **Pairs are sorted** before hashing, matching OpenZeppelin's commutative hash. That is why
 *      the proof carries no left/right flags.
 *
 *   3. **Odd nodes are promoted** unchanged to the next level rather than duplicated. Duplicating
 *      is the other common convention and produces a different root.
 */
export class MerkleAllowlist {
  private readonly leaves: Hex[];
  private readonly layers: Hex[][];
  private readonly indexByAddress: Map<string, number>;

  constructor(entries: AllowlistEntry[]) {
    if (entries.length === 0) {
      throw new Error('MerkleAllowlist: cannot build a tree with no entries');
    }

    // Sorting by leaf makes the tree deterministic: the same entry set always produces the same
    // root regardless of input order, so a rebuild does not invalidate previously issued proofs.
    const decorated = entries
      .map((entry) => ({entry, leaf: MerkleAllowlist.leafFor(entry)}))
      .sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));

    this.leaves = decorated.map((item) => item.leaf);
    this.indexByAddress = new Map(
      decorated.map((item, index) => [item.entry.address.toLowerCase(), index]),
    );

    this.layers = [this.leaves];
    while (this.layers[this.layers.length - 1]!.length > 1) {
      this.layers.push(MerkleAllowlist.nextLayer(this.layers[this.layers.length - 1]!));
    }
  }

  /** `keccak256(keccak256(abi.encode(address, allowance)))`. */
  static leafFor(entry: AllowlistEntry): Hex {
    const inner = keccak256(
      encodeAbiParameters(
        [{type: 'address'}, {type: 'uint256'}],
        [entry.address, BigInt(entry.allowance)],
      ),
    );
    return keccak256(inner);
  }

  get root(): Hex {
    return this.layers[this.layers.length - 1]![0]!;
  }

  /** Proof for an address, or null if it is not on the list. */
  proofFor(address: string): Hex[] | null {
    const index = this.indexByAddress.get(address.toLowerCase());
    if (index === undefined) return null;

    const proof: Hex[] = [];
    let position = index;

    for (let level = 0; level < this.layers.length - 1; level += 1) {
      const layer = this.layers[level]!;
      const siblingIndex = position ^ 1;

      // A promoted odd node has no sibling at this level and contributes nothing to the proof.
      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]!);
      }

      position = Math.floor(position / 2);
    }

    return proof;
  }

  /** Local verification, used by the tests and as a self-check before publishing a root. */
  verify(entry: AllowlistEntry, proof: Hex[]): boolean {
    let computed = MerkleAllowlist.leafFor(entry);

    for (const sibling of proof) {
      computed = MerkleAllowlist.hashPair(computed, sibling);
    }

    return computed === this.root;
  }

  private static nextLayer(layer: Hex[]): Hex[] {
    const next: Hex[] = [];

    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = layer[i + 1];
      next.push(right === undefined ? left : MerkleAllowlist.hashPair(left, right));
    }

    return next;
  }

  /** Commutative hash, matching OpenZeppelin's `Hashes.commutativeKeccak256`. */
  private static hashPair(a: Hex, b: Hex): Hex {
    return a < b ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));
  }
}
