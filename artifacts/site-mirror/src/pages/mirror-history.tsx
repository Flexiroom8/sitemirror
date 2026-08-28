import { useEffect } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, FileArchive, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { useListMirrorJobs, type MirrorJob } from '@workspace/api-client-react';
import { formatBytes, formatDate } from '@/lib/mirror-format';

function StatusPill({ status }: { status: MirrorJob['status'] }) {
  const labels = { queued: 'Queued', running: 'Mirroring', completed: 'Complete', failed: 'Failed', cancelled: 'Cancelled' };
  const colors = {
    queued: 'bg-[hsl(var(--accent)/.17)] text-[hsl(var(--accent-foreground))]',
    running: 'bg-[hsl(157_36%_77%/.35)] text-[hsl(158_39%_27%)]',
    completed: 'bg-[hsl(157_36%_77%/.55)] text-[hsl(158_39%_27%)]',
    failed: 'bg-[hsl(var(--destructive)/.14)] text-[hsl(var(--destructive))]',
    cancelled: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.12em] ${colors[status]}`}><span className={`h-1.5 w-1.5 rounded-full ${status === 'running' ? 'signal-dot bg-[hsl(157_43%_40%)]' : 'bg-current'}`} />{labels[status]}</span>;
}

export default function MirrorHistory() {
  const query = useListMirrorJobs({ limit: 50 });
  const jobs = query.data?.jobs ?? [];

  useEffect(() => {
    document.title = 'Job history · Site Mirror';
  }, []);

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
      <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
        <div className="mx-auto flex max-w-[1220px] items-center justify-between px-5 py-4 md:px-10"><Link href="/" data-testid="link-home-from-history" className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"><Network className="h-4 w-4" /></span><span className="text-sm font-extrabold tracking-[-.03em]">site mirror</span></Link><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.6)]"><ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />authorized control room</div></div>
      </header>
      <main className="mx-auto max-w-[1220px] px-5 py-8 md:px-10 md:py-11">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <Link href="/" data-testid="link-back-new-mirror-history" className="inline-flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--primary))]"><ArrowLeft className="h-3.5 w-3.5" />New mirror</Link>
          <button data-testid="button-refresh-history" onClick={() => query.refetch()} disabled={query.isFetching} className="inline-flex h-9 items-center gap-2 rounded-xl border border-[hsl(var(--border))] px-3.5 text-xs font-bold hover:bg-[hsl(var(--muted))] disabled:opacity-60"><RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? 'animate-spin' : ''}`} />Refresh</button>
        </div>
        <div className="mb-6"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--accent-foreground))]">Job history</p><h1 className="mt-2 text-3xl font-extrabold tracking-[-.045em]">Every mirror this workspace has run</h1><p className="mt-1.5 text-sm text-[hsl(var(--muted-foreground))]">The most recent 50 jobs, newest first. Finished jobs are kept for a limited window before their files are cleared.</p></div>

        {query.isLoading && (
          <div className="animate-pulse space-y-3">
            <div className="h-20 rounded-xl bg-[hsl(var(--muted))]" />
            <div className="h-20 rounded-xl bg-[hsl(var(--muted))]" />
            <div className="h-20 rounded-xl bg-[hsl(var(--muted))]" />
          </div>
        )}

        {query.error && (
          <div className="rounded-xl border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.07)] p-4 text-sm text-[hsl(var(--destructive))]">Job history could not be loaded. Try refreshing.</div>
        )}

        {!query.isLoading && !query.error && jobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/.42)] p-8 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))]"><FileArchive className="h-5 w-5" /></div>
            <p className="text-sm font-semibold">No mirror jobs yet</p>
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Start a mirror from the new mirror screen and it will show up here.</p>
          </div>
        )}

        {jobs.length > 0 && (
          <div className="space-y-3">
            {jobs.map((job) => (
              <Link key={job.id} href={`/jobs/${job.id}`} data-testid={`link-history-job-${job.id}`} className="group block rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[hsl(var(--accent-border))] hover:shadow-[var(--shadow-sm)] sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{job.url.replace(/^https?:\/\//, '')}</p>
                    <p className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{formatDate(job.createdAt)} · {job.pagesDownloaded} pages · {formatBytes(job.bytesDownloaded)}</p>
                  </div>
                  <StatusPill status={job.status} />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-[hsl(var(--border))] pt-3 text-xs font-semibold text-[hsl(var(--primary))]"><span>Open job monitor</span><ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" /></div>
              </Link>
            ))}
          </div>
        )}

        <footer className="mt-10 flex flex-col gap-3 border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center sm:justify-between"><span>Site Mirror keeps the crawl legible.</span><span className="font-mono tracking-[.1em]">{jobs.length} JOB{jobs.length === 1 ? '' : 'S'} SHOWN</span></footer>
      </main>
    </div>
  );
}
