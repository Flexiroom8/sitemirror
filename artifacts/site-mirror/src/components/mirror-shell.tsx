import { Link } from 'wouter';
import { History, Network, ScanSearch, ShieldCheck } from 'lucide-react';
import type { MirrorJob } from '@workspace/api-client-react';

const statusLabels: Record<MirrorJob['status'], string> = {
  queued: 'Queued',
  running: 'Mirroring',
  completed: 'Complete',
  completed_with_warnings: 'Warnings',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const statusColors: Record<MirrorJob['status'], string> = {
  queued: 'bg-[hsl(var(--accent)/.17)] text-[hsl(var(--accent-foreground))]',
  running: 'bg-[hsl(157_36%_77%/.35)] text-[hsl(158_39%_27%)]',
  completed: 'bg-[hsl(157_36%_77%/.55)] text-[hsl(158_39%_27%)]',
  completed_with_warnings: 'bg-[hsl(var(--accent)/.25)] text-[hsl(39_65%_28%)]',
  failed: 'bg-[hsl(var(--destructive)/.14)] text-[hsl(var(--destructive))]',
  cancelled: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
};

export function SiteMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] shadow-sm">
        <Network className="h-[18px] w-[18px]" strokeWidth={2.3} />
        <span className="signal-dot absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[hsl(var(--card))]" />
      </div>
      {!compact && (
        <div>
          <p className="text-[15px] font-extrabold tracking-[-.03em]">site mirror</p>
          <p className="font-mono text-[9px] uppercase tracking-[.2em] text-[hsl(var(--sidebar-foreground)/.56)]">controlled archive</p>
        </div>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: MirrorJob['status'] }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.12em] ${statusColors[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'running' ? 'signal-dot bg-[hsl(157_43%_40%)]' : 'bg-current'}`} />
      {statusLabels[status]}
    </span>
  );
}

export function phaseLabel(phase: MirrorJob['progressPhase']): string {
  return {
    queued: 'Waiting in queue',
    discovering: 'Discovering pages',
    saving: 'Saving pages',
    downloading_assets: 'Collecting assets',
    rewriting: 'Rewriting local links',
    packaging: 'Sealing archive',
  }[phase];
}

export function MirrorHeader({ preview = false }: { preview?: boolean }) {
  return (
    <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
      <div className="mx-auto flex max-w-[1220px] items-center justify-between gap-4 px-5 py-4 md:px-10">
        <Link href="/" aria-label="Site Mirror home" className="flex items-center gap-3">
          <SiteMark compact />
          <span className="hidden text-sm font-extrabold tracking-[-.03em] sm:inline">site mirror</span>
        </Link>
        <nav aria-label="Primary navigation" className="flex items-center gap-4">
          <Link href="/" className="hidden items-center gap-1.5 text-xs font-bold text-[hsl(var(--primary-foreground)/.7)] transition-colors hover:text-[hsl(var(--primary-foreground))] sm:inline-flex">
            <ScanSearch className="h-3.5 w-3.5" />
            New mirror
          </Link>
          <Link href="/history" className="inline-flex items-center gap-1.5 text-xs font-bold text-[hsl(var(--primary-foreground)/.7)] transition-colors hover:text-[hsl(var(--primary-foreground))]">
            <History className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">History</span>
          </Link>
          <div className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.6)] lg:flex">
            <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />
            {preview ? 'snapshot preview' : 'authorized control room'}
          </div>
        </nav>
      </div>
    </header>
  );
}