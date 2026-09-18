import { useState } from 'react';
import { Check, GitBranch, X } from 'lucide-react';
import type { Request } from '../simulation/types';

export function PrefixInspector({ request: r, blockSize }: { request?: Request; blockSize: number }) {
  const [index, setIndex] = useState(0);
  if (!r) return null;
  const block = r.prefixLookup[index] ?? r.prefixChain[index];
  const pending = r.admittedAt === undefined;
  const hit = r.prefixLookup[index]?.hit ?? false;
  const shared = r.prefix === 'none' ? 0 : Math.min(128, Math.floor(r.promptTokens / 2));
  return <section className="prefix-inspector">
    <div className="section-heading"><h2><GitBranch size={15} /> Prefix hash chain</h2><span className="mono">{r.id}</span></div>
    <div className="logical-segments"><span>System prompt</span><span>Shared context</span><span>User query</span><span>Generated tokens</span></div>
    <p className="comparison-note">{pending ? 'Lookup pending admission · no hit/miss result yet.' : `${r.cachedTokens} tokens reused · ${r.prefixLookup.filter(b => b.hit).length} cached blocks · ${r.prefixChain.length - r.prefixLookup.filter(b => b.hit).length} new full prompt blocks.`} Segment names illustrate family-generated prompts.</p>
    <div className="hash-chain" aria-label="Logical prefix block chain">{r.prefixChain.map((b, i) => {
      const found = r.prefixLookup[i]?.hit;
      const label = pending ? 'PENDING' : found ? 'HIT' : 'MISS';
      return <button key={i} className={`hash-block ${found ? 'hit' : pending ? 'pending' : 'miss'} ${i === index ? 'selected' : ''}`} aria-label={`Prefix block ${i}: ${label}`} onClick={() => setIndex(i)}>
        <b>B{i}</b><code>{b.hash.slice(0, 6)}</code><span>{!pending && (found ? <Check size={12} /> : <X size={12} />)}{label}</span>
      </button>;
    })}</div>
    {block && <div className="hash-detail mono" data-testid="prefix-block-detail">
      <strong>BLOCK {index} · {pending ? 'PENDING' : hit ? 'HIT' : 'MISS'} · {block.start < shared / 2 ? 'System prompt' : block.start < shared ? 'Shared context' : 'User query'}</strong>
      <span>parent {block.parentHash} → hash {block.hash}</span><span>tokens [{block.start}, {block.end}) · {blockSize} immutable positions</span>
      <span>{pending ? 'Not looked up: request has not been admitted.' : hit ? `Reused physical page ${r.prefixLookup[index].page} at admission` : 'Not reused at admission; lookup stops after the first miss'}</span>
    </div>}
    <p className="comparison-note">{r.promptTokens % blockSize ? `${r.promptTokens % blockSize} prompt tail tokens remain private. ` : ''}{r.generated} generated tokens have private KV. Hash = H(parent hash, token content); exact prefix identity also checked.</p>
  </section>;
}
