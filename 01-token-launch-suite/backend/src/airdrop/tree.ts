import {concatHex, encodeAbiParameters, keccak256, type Hex} from 'viem';

export interface AirdropEntry {
  index: number;
  address: `0x${string}`;
  amount: bigint;
}

/**
 * Merkle tree for the airdrop, matching `MerkleDistributor.claim` exactly.
 *
 * Three details have to line up with the contract, and getting any of them wrong produces a tree
 * that looks correct locally while every on-chain claim reverts with `InvalidProof`:
 *
 *   1. **Leaf encoding** is `keccak256(keccak256(abi.encode(index, account, amount)))`. The index
 *      is what drives the on-chain claim bitmap, and the account binds the allocation so a proof
 *      cannot be redirected by whoever submits the transaction. The double hash prevents a 64-byte
 *      internal node being replayed as a leaf.
 *
 *   2. **Pairs are sorted** before hashing, matching OpenZeppelin's commutative hash. That is why
 *      proofs carry no left/right flags.
 *
 *   3. **Odd nodes are promoted** unchanged rather than duplicated. Duplicating is the other common
 *      convention and yields a different root.
 *
 * Unlike an allowlist, entries are **not** re-sorted by leaf. The tree is built in index order,
 * because the index must stay dense and stable: it addresses a bit in the on-chain bitmap, and
 * reshuffling it after publication would invalidate every claim.
 */
export class AirdropTree {
  private readonly layers: Hex[][];
  private readonly positionByIndex: Map<number, number>;
  private readonly entries: AirdropEntry[];

  constructor(entries: AirdropEntry[]) {
    if (entries.length === 0) {
      throw new Error('AirdropTree: cannot build a tree with no entries');
    }

    // Index order, not leaf order. See the class note above.
    this.entries = [...entries].sort((a, b) => a.index - b.index);

    const seenIndex = new Set<number>();
    const seenAddress = new Set<string>();

    for (const entry of this.entries) {
      if (seenIndex.has(entry.index)) {
        throw new Error(`AirdropTree: duplicate index ${entry.index}`);
      }
      const address = entry.address.toLowerCase();
      if (seenAddress.has(address)) {
        // Two leaves for one wallet would let it claim twice, since the bitmap keys on index.
        throw new Error(`AirdropTree: duplicate address ${entry.address}`);
      }
      seenIndex.add(entry.index);
      seenAddress.add(address);
    }

    this.positionByIndex = new Map(this.entries.map((entry, position) => [entry.index, position]));

    const leaves = this.entries.map((entry) => AirdropTree.leafFor(entry));
    this.layers = [leaves];

    while (this.layers[this.layers.length - 1]!.length > 1) {
      this.layers.push(AirdropTree.nextLayer(this.layers[this.layers.length - 1]!));
    }
  }

  /** `keccak256(keccak256(abi.encode(index, account, amount)))`. */
  static leafFor(entry: AirdropEntry): Hex {
    const inner = keccak256(
      encodeAbiParameters(
        [{type: 'uint256'}, {type: 'address'}, {type: 'uint256'}],
        [BigInt(entry.index), entry.address, entry.amount],
      ),
    );
    return keccak256(inner);
  }

  get root(): Hex {
    return this.layers[this.layers.length - 1]![0]!;
  }

  get size(): number {
    return this.entries.length;
  }

  get totalAmount(): bigint {
    return this.entries.reduce((sum, entry) => sum + entry.amount, 0n);
  }

  /** Proof for an allocation index, or null if it is not in the tree. */
  proofFor(index: number): Hex[] | null {
    const start = this.positionByIndex.get(index);
    if (start === undefined) return null;

    const proof: Hex[] = [];
    let position = start;

    for (let level = 0; level < this.layers.length - 1; level += 1) {
      const layer = this.layers[level]!;
      const sibling = position ^ 1;

      // A promoted odd node has no sibling at this level and contributes nothing.
      if (sibling < layer.length) {
        proof.push(layer[sibling]!);
      }

      position = Math.floor(position / 2);
    }

    return proof;
  }

  /** Local verification, used by the tests and as a self-check before publishing a root. */
  verify(entry: AirdropEntry, proof: Hex[]): boolean {
    let computed = AirdropTree.leafFor(entry);

    for (const sibling of proof) {
      computed = AirdropTree.hashPair(computed, sibling);
    }

    return computed === this.root;
  }

  private static nextLayer(layer: Hex[]): Hex[] {
    const next: Hex[] = [];

    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = layer[i + 1];
      next.push(right === undefined ? left : AirdropTree.hashPair(left, right));
    }

    return next;
  }

  /** Commutative hash, matching OpenZeppelin's `Hashes.commutativeKeccak256`. */
  private static hashPair(a: Hex, b: Hex): Hex {
    return a < b ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));
  }
}
