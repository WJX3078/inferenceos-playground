# Prefix cache identity

The v0.1 playground identified cached prefix pages by `(family, blockIndex)` — every `chat` request shared page 0 of `chat`, regardless of actual content. That was a simplification with a failure mode: **two requests with the same family name but different token content would falsely share cache**. InferenceOS Lab fixes this with content-based identity.

## Synthetic token streams

Every prompt is a deterministic synthetic token sequence:

- **Prefix region** (up to 128 tokens, whole blocks, at most half the prompt): token `i` = `hash(familyBase, i)` — identical for every request of the same family.
- **Tail region**: token `i` = `hash(requestSeed, i)` — unique per request.

`familyBase` is derived from the family name; `requestSeed` from the engine seed + request serial. There are no real tokens or text — the streams exist so that *identity* is well-defined.

## Content-addressed blocks

A full block's cache key is a rolling hash over its token ids, **chained to the previous block**:

```
h(-1) = hash(familyBase, salt)
h(i)  = hash(h(i-1), tokens[i·bs .. (i+1)·bs))
key(i) = hex(h(i))
```

The chain makes the identity a *prefix* identity: block 3 of a prompt only hashes to the same value if blocks 0–2 match too. The pool keeps `key → blockId` in a content table; `publish()` registers a request's full immutable prefix blocks at prefill completion (first publisher wins; concurrent cold prefills keep one canonical copy).

## What can and cannot be shared

- ✅ **Full, immutable, published prefix blocks** — refcounted, never written after publication, shared by any request whose token content hashes identically *as a contiguous run*.
- ❌ **Mutable tails** — never shared, never keyed. Two requests with identical tails share nothing until their prefix region is published.
- ❌ **Partial runs** — a match walk stops at the first missing hash; a hole in the middle cannot be jumped over. Reuse is always the longest matching *prefix*.
- ❌ **Same-family, different-content** — different families derive different token streams; different seeds derive different tails. Sharing requires actual content equality.

This is the same shape as vLLM's `hash(parent_hash, block_token_ids)` prefix caching (and SGLang's RadixAttention idea), without the radix tree: the simulator keeps a flat content table; a trie/radix visualization is a possible future addition. The Cache panel shows each block's 8-hex content hash in the block detail.

## Tier interaction

With multi-tier KV enabled, a lookup miss falls through GPU → CPU → Remote (see [kv-cache.md](kv-cache.md)); restores land the exact content blocks back into the GPU pool. Because identity is content-based, a restored block is indistinguishable from a never-evicted one.

## What to observe

- `prefix-heavy` scenario: the first request pays the cold prefill; later requests reuse the shared blocks (purple), emit `prefix-hit` events, and show visibly lower TTFT — the regression test asserts warm TTFT < cold TTFT and warm prefill work < cold.
- Toggle prefix caching off: same traffic, no reuse, every request pays full prefill.
- Export a run and inspect `observations[].cachedTokens`: warm requests report the reused token count.
