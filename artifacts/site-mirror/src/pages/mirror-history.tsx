import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, ArrowRight, FileArchive, Filter, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useListMirrorJobs, type MirrorJob } from '@workspace/api-client-react';
import { MirrorHeader, StatusPill } from '@/components/mirror-shell';
import { formatBytes, formatDate, saveMirrorPrefill } from '@/lib/mirror-format';

export default function MirrorHistory() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | MirrorJob['status']>('all');
  const query = useListMirrorJobs({ limit: 50 });
  const jobs = query.data?.jobs ?? [];
  const filteredJobs = useMemo(() => jobs.filter((job) => {
    const matchesStatus = statusFilter === 'all' || job.status === statusFilter;
    const matchesSearch = !search.trim() || job.url.toLowerCase().includes(search.trim().toLowerCase());
    return matchesStatus && matchesSearch;
  }), [jobs, search, statusFilter]);
  const completedCount = jobs.filter((job) => job.status === 'completed' || job.status === 'completed_with_warnings').length;
  const activeCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const warningCount = jobs.filter((job) => job.status === 'completed_with_warnings').length;

  const rerun = (job: MirrorJob) => {
    saveMirrorPrefill({
      url: job.url,
      maxPages: job.maxPages,
      requestDelayMs: job.requestDelayMs,
      respectRobotsTxt: job.respectRobotsTxt,
      maxDepth: job.maxDepth ?? 3,
      includeAssets: job.includeAssets ?? true,
      pathPrefix: job.pathPrefix ?? '/',
      excludePaths: job.excludePaths ?? [],
      timeoutMs: job.timeoutMs ?? 900_000,
      maxTotalBytes: job.maxTotalBytes ?? 524_288_000,
    });
    setLocation('/');
  };

  useEffect(() => {
    document.title = 'Job history · Site Mirror';
  }, []);

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
      <MirrorHeader />
      <main className="mx-auto max-w-[1220px] px-5 py-8 md:px-10 md:py-11">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <Link href="/" data-testid="link-back-new-mirror-history" className="inline-flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--primary))]"><ArrowLeft className="h-3.5 w-3.5" />New mirror</Link>
          <button data-testid="button-refresh-history" onClick={() => query.refetch()} disabled={query.isFetching} className="inline-flex h-9 items-center gap-2 rounded-xl border border-[hsl(var(--border))] px-3.5 text-xs font-bold hover:bg-[hsl(var(--muted))] disabled:opacity-60"><RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? 'animate-spin' : ''}`} />Refresh</button>
        </div>
        <div className="mb-6"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--accent-foreground))]">Job history</p><h1 className="mt-2 text-3xl font-extrabold tracking-[-.045em]">Every mirror this workspace has run</h1><p className="mt-1.5 text-sm text-[hsl(var(--muted-foreground))]">The most recent 50 jobs, newest first. Finished jobs are kept for a limited window before their files are cleared.</p></div>

        <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"><p className="font-mono text-2xl">{jobs.length}</p><p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">jobs shown</p></div>
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"><p className="font-mono text-2xl text-[hsl(158_39%_27%)]">{completedCount}</p><p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">archives ready</p></div>
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"><p className="font-mono text-2xl text-[hsl(var(--accent-foreground))]">{activeCount}</p><p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">in progress</p></div>
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"><p className="font-mono text-2xl text-[hsl(var(--destructive))]">{warningCount}</p><p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">with warnings</p></div>
        </div>

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

        {jobs.length > 0 && (
          <section aria-label="Filter mirror jobs" className="mb-5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
                <input aria-label="Search jobs by URL" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by starting URL" className="h-10 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] pl-9 pr-3 text-sm outline-none focus:border-[hsl(var(--accent-border))]" />
              </div>
              <div className="flex items-center gap-2 overflow-x-auto text-xs">
                <Filter className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--muted-foreground))]" />
                {(['all', 'running', 'completed', 'completed_with_warnings', 'failed'] as const).map((status) => (
                  <button key={status} type="button" onClick={() => setStatusFilter(status)} className={`whitespace-nowrap rounded-lg px-3 py-2 font-bold transition-colors ${statusFilter === status ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]'}`}>
                    {status === 'all' ? 'All' : status === 'running' ? 'Active' : status === 'completed' ? 'Ready' : status === 'completed_with_warnings' ? 'Warnings' : 'Failed'}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {!query.isLoading && !query.error && jobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/.42)] p-8 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))]"><FileArchive className="h-5 w-5" /></div>
            <p className="text-sm font-semibold">No mirror jobs yet</p>
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Start a mirror from the new mirror screen and it will show up here.</p>
          </div>
        )}

        {jobs.length > 0 && filteredJobs.length === 0 && (
          <div className="rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/.42)] p-8 text-center">
            <Search className="mx-auto h-5 w-5 text-[hsl(var(--muted-foreground))]" />
            <p className="mt-3 text-sm font-semibold">No jobs match those filters</p>
            <button type="button" onClick={() => { setSearch(''); setStatusFilter('all'); }} className="mt-3 text-xs font-bold text-[hsl(var(--primary))] underline underline-offset-4">Clear filters</button>
          </div>
        )}

        {filteredJobs.length > 0 && (
          <div className="space-y-3">
            {filteredJobs.map((job) => (
              <article key={job.id} className="group rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 transition-[transform,border-color,box-shadow] hover:-translate-y-0.5 hover:border-[hsl(var(--accent-border))] hover:shadow-[var(--shadow-sm)] sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <Link href={`/jobs/${job.id}`} data-testid={`link-history-job-${job.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{job.url.replace(/^https?:\/\//, '')}</p>
                    <p className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{formatDate(job.createdAt)} · {job.pagesDownloaded} pages · {formatBytes(job.bytesDownloaded)}</p>
                  </Link>
                  <StatusPill status={job.status} />
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--border))] pt-3">
                  <Link href={`/jobs/${job.id}`} className="inline-flex items-center gap-2 text-xs font-semibold text-[hsl(var(--primary))]">Open job monitor <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" /></Link>
                  <button type="button" onClick={() => rerun(job)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-2.5 text-[11px] font-bold text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--primary))]"><RotateCcw className="h-3.5 w-3.5" />Run again</button>
                </div>
              </article>
            ))}
          </div>
        )}

        <footer className="mt-10 flex flex-col gap-3 border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center sm:justify-between"><span>Site Mirror keeps the crawl legible.</span><span className="font-mono tracking-[.1em]">{jobs.length} JOB{jobs.length === 1 ? '' : 'S'} SHOWN</span></footer>
      </main>
    </div>
  );
}
