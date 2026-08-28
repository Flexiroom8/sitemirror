import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  CloudDownload,
  FileArchive,
  FileCode2,
  Gauge,
  Globe2,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Network,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  Square,
  Timer,
} from 'lucide-react';
import {
  getDownloadMirrorJobQueryKey,
  getGetMirrorJobQueryKey,
  useCancelMirrorJob,
  useDownloadMirrorJob,
  useGetMirrorJob,
  type MirrorJob,
} from '@workspace/api-client-react';
import { formatBytes, formatDateTime as formatDate } from '@/lib/mirror-format';


function statusCopy(status: MirrorJob['status']) {
  return {
    queued: { label: 'Queued', title: 'Your mirror is in line.', body: 'The crawl will begin shortly. Scope is locked and ready.' },
    running: { label: 'Mirroring', title: 'The archive is taking shape.', body: 'Site Mirror is following the site, one respectful request at a time.' },
    completed: { label: 'Complete', title: 'Your local copy is ready.', body: 'Every file in scope has been collected and packaged for download.' },
    failed: { label: 'Stopped with an error', title: 'The mirror needs attention.', body: 'The crawl could not finish. Review the message below and try a new job when ready.' },
    cancelled: { label: 'Cancelled', title: 'The crawl was stopped.', body: 'No more requests will be made for this mirror job.' },
  }[status];
}

function StatusBadge({ status }: { status: MirrorJob['status'] }) {
  const tone = {
    queued: 'text-[hsl(var(--accent-foreground))] bg-[hsl(var(--accent)/.18)]',
    running: 'text-[hsl(158_39%_27%)] bg-[hsl(157_36%_77%/.55)]',
    completed: 'text-[hsl(158_39%_27%)] bg-[hsl(157_36%_77%/.7)]',
    failed: 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/.12)]',
    cancelled: 'text-[hsl(var(--muted-foreground))] bg-[hsl(var(--muted))]',
  }[status];
  return <span data-testid="status-job" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.14em] ${tone}`}><span className={`h-1.5 w-1.5 rounded-full bg-current ${status === 'running' ? 'signal-dot' : ''}`} />{statusCopy(status).label}</span>;
}

function Stat({ icon: Icon, label, value, detail, testId }: { icon: typeof FileCode2; label: string; value: string; detail?: string; testId: string }) {
  return <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4"><div className="flex items-center justify-between"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Icon className="h-4 w-4" /></span>{detail && <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{detail}</span>}</div><p className="mt-5 font-mono text-2xl font-medium tracking-[-.06em]" data-testid={testId}>{value}</p><p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{label}</p></div>;
}

function JobSkeleton() {
  return <div className="mx-auto max-w-[1120px] animate-pulse px-5 py-10 md:px-10"><div className="h-4 w-28 rounded bg-[hsl(var(--muted))]" /><div className="mt-8 h-44 rounded-[1.5rem] bg-[hsl(var(--muted))]" /><div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4"><div className="h-32 rounded-xl bg-[hsl(var(--muted))]" /><div className="h-32 rounded-xl bg-[hsl(var(--muted))]" /><div className="h-32 rounded-xl bg-[hsl(var(--muted))]" /><div className="h-32 rounded-xl bg-[hsl(var(--muted))]" /></div></div>;
}

export default function MirrorJobPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const id = params.id ?? '';
  const [cancelError, setCancelError] = useState('');
  const query = useGetMirrorJob(id, { query: { queryKey: getGetMirrorJobQueryKey(id), enabled: Boolean(id), refetchInterval: (queryData) => queryData.state.data?.status === 'queued' || queryData.state.data?.status === 'running' ? 1800 : false } });
  const cancelJob = useCancelMirrorJob();
  const download = useDownloadMirrorJob(id, { query: { queryKey: getDownloadMirrorJobQueryKey(id), enabled: false } });
  const job = query.data;
  const progress = useMemo(() => {
    if (!job) return 0;
    if (job.status === 'completed') return 100;
    if (!job.maxPages) return 0;
    return Math.min(99, Math.round((job.pagesDownloaded / job.maxPages) * 100));
  }, [job]);

  useEffect(() => {
    document.title = job ? `${job.url.replace(/^https?:\/\//, '')} · Site Mirror` : 'Mirror job · Site Mirror';
  }, [job]);

  if (query.isLoading) return <div className="min-h-[100dvh] bg-[hsl(var(--background))]"><JobSkeleton /></div>;
  if (query.error || !job) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-[hsl(var(--background))] px-5"><div className="w-full max-w-md rounded-[1.4rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-7 text-center shadow-[var(--shadow-md)]"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]"><CircleAlert className="h-5 w-5" /></div><h1 className="mt-5 text-xl font-extrabold tracking-[-.03em]">This mirror is out of reach</h1><p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">We could not find that job or the control room is temporarily unavailable.</p><div className="mt-6 flex justify-center gap-3"><button data-testid="button-retry-job" onClick={() => query.refetch()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[hsl(var(--border))] px-4 text-xs font-bold hover:bg-[hsl(var(--muted))]"><RefreshCw className="h-3.5 w-3.5" />Try again</button><Link href="/" data-testid="link-back-home" className="inline-flex h-10 items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 text-xs font-bold text-[hsl(var(--primary-foreground))]">New mirror</Link></div></div></div>;
  }

  const copy = statusCopy(job.status);
  const isActive = job.status === 'running' || job.status === 'queued';
  const canDownload = job.status === 'completed';
  const cancel = () => {
    if (!window.confirm('Stop this mirror job? No additional requests will be made.')) return;
    setCancelError('');
    cancelJob.mutate({ id: job.id }, { onSuccess: () => query.refetch(), onError: () => setCancelError('The job could not be cancelled. Try again.') });
  };
  const downloadArchive = async () => {
    const result = await download.refetch();
    if (result.data instanceof Blob) {
      const url = URL.createObjectURL(result.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `site-mirror-${job.id}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
      <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
        <div className="mx-auto flex max-w-[1220px] items-center justify-between px-5 py-4 md:px-10"><Link href="/" data-testid="link-home-from-job" className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"><Network className="h-4 w-4" /></span><span className="text-sm font-extrabold tracking-[-.03em]">site mirror</span></Link><div className="flex items-center gap-5"><Link href="/history" data-testid="link-history-from-job" className="text-xs font-bold text-[hsl(var(--primary-foreground)/.7)] transition-colors hover:text-[hsl(var(--primary-foreground))]">Job history</Link><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.6)]"><ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />authorized control room</div></div></div>
      </header>
      <main className="mx-auto max-w-[1220px] px-5 py-8 md:px-10 md:py-11">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4"><Link href="/" data-testid="link-back-new-mirror" className="inline-flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--primary))]"><ArrowLeft className="h-3.5 w-3.5" />New mirror</Link><p className="font-mono text-[10px] uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">Job <span className="text-[hsl(var(--primary))]">{job.id.slice(0, 12)}</span></p></div>
        <section className="animate-rise-in overflow-hidden rounded-[1.55rem] bg-[hsl(var(--primary))] p-6 text-[hsl(var(--primary-foreground))] shadow-[var(--shadow-lg)] md:p-9">
          <div className="flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between"><div className="min-w-0"><div className="mb-4 flex flex-wrap items-center gap-3"><StatusBadge status={job.status} /><span className="font-mono text-[10px] text-[hsl(var(--primary-foreground)/.5)]">started {formatDate(job.createdAt)}</span></div><h1 className="max-w-3xl truncate text-3xl font-extrabold tracking-[-.055em] md:text-5xl">{copy.title}</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[hsl(var(--primary-foreground)/.67)]">{copy.body}</p></div><div className="shrink-0">{canDownload ? <button data-testid="button-download-mirror" onClick={downloadArchive} disabled={download.isFetching} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[hsl(var(--accent))] px-5 text-xs font-extrabold text-[hsl(var(--accent-foreground))] shadow-[0_4px_0_hsl(39_65%_37%)] transition-transform hover:-translate-y-0.5 disabled:opacity-70">{download.isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}{download.isFetching ? 'Preparing archive...' : 'Download .zip'}</button> : isActive ? <button data-testid="button-cancel-mirror" onClick={cancel} disabled={cancelJob.isPending} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[hsl(var(--primary-foreground)/.25)] bg-[hsl(var(--primary-foreground)/.07)] px-5 text-xs font-bold text-[hsl(var(--primary-foreground))] transition-colors hover:bg-[hsl(var(--primary-foreground)/.14)] disabled:opacity-60"><Square className="h-3 w-3 fill-current" />{cancelJob.isPending ? 'Stopping...' : 'Stop mirror'}</button> : null}</div></div>
          {isActive && <div className="mt-8 border-t border-[hsl(var(--primary-foreground)/.16)] pt-6"><div className="mb-3 flex items-end justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[hsl(var(--primary-foreground)/.54)]">Pages collected</p><p className="mt-1 font-mono text-2xl">{job.pagesDownloaded} <span className="text-sm text-[hsl(var(--primary-foreground)/.48)]">/ {job.maxPages}</span></p></div><span data-testid="text-job-progress" className="font-mono text-2xl text-[hsl(var(--accent))]">{progress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--primary-foreground)/.12)]"><div className="h-full rounded-full bg-[hsl(var(--accent))] transition-[width] duration-700 ease-out" style={{ width: `${Math.max(progress, job.status === 'queued' ? 4 : progress)}%` }} /></div><div className="mt-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-[hsl(var(--primary-foreground)/.5)]"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))] signal-dot" />updates every 1.8 seconds</div></div>}
          {job.status === 'completed' && <div className="mt-8 flex items-center gap-3 border-t border-[hsl(var(--primary-foreground)/.16)] pt-6 text-sm text-[hsl(var(--primary-foreground)/.72)]"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(157_36%_77%/.25)] text-[hsl(157_60%_76%)]"><Check className="h-4 w-4" /></span>Archive sealed on {formatDate(job.completedAt)}</div>}
          {job.message && <div data-testid="status-job-message" className={`mt-6 flex gap-2 rounded-xl border px-4 py-3 text-xs ${job.status === 'failed' ? 'border-[hsl(var(--destructive)/.35)] bg-[hsl(var(--destructive)/.13)] text-[hsl(5_80%_84%)]' : 'border-[hsl(var(--primary-foreground)/.17)] bg-[hsl(var(--primary-foreground)/.06)] text-[hsl(var(--primary-foreground)/.72)]'}`}><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{job.message}</div>}
        </section>
        {cancelError && <div data-testid="status-cancel-error" className="mt-4 rounded-xl border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.07)] px-4 py-3 text-xs font-semibold text-[hsl(var(--destructive))]">{cancelError}</div>}

        <section className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat icon={FileCode2} label="Pages found" value={job.pagesFound.toLocaleString()} testId="text-pages-found" />
          <Stat icon={FileArchive} label="Pages downloaded" value={job.pagesDownloaded.toLocaleString()} testId="text-pages-downloaded" />
          <Stat icon={HardDrive} label="Assets downloaded" value={job.assetsDownloaded.toLocaleString()} testId="text-assets-downloaded" />
          <Stat icon={Gauge} label="Archive size" value={formatBytes(job.bytesDownloaded)} testId="text-bytes-downloaded" />
        </section>

        <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
          <section className="rounded-[1.35rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-[var(--shadow-sm)] md:p-7"><div className="mb-6 flex items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--accent-foreground))]">Live telemetry</p><h2 className="mt-2 text-xl font-extrabold tracking-[-.035em]">What the crawler is doing</h2></div><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">{isActive ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}</div></div><div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4"><div className="flex items-center gap-2 text-[11px] font-bold text-[hsl(var(--muted-foreground))]"><Globe2 className="h-3.5 w-3.5 text-[hsl(var(--accent-foreground))]" />Current URL</div><p data-testid="text-current-url" className="mt-3 break-all font-mono text-xs leading-5 text-[hsl(var(--primary))]">{job.currentUrl || (job.status === 'queued' ? 'Waiting for the first request...' : 'No active request')}</p>{isActive && <div className="mt-4 h-1 overflow-hidden rounded-full bg-[hsl(var(--secondary))]"><div className="crawl-bar-indeterminate h-full w-1/3 rounded-full bg-[hsl(var(--accent))]" /></div>}</div><div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] p-3"><Timer className="h-4 w-4 text-[hsl(var(--accent-foreground))]" /><div><p className="font-mono text-sm">{job.requestDelayMs} ms</p><p className="text-[10px] text-[hsl(var(--muted-foreground))]">request delay</p></div></div><div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] p-3"><ShieldCheck className="h-4 w-4 text-[hsl(var(--accent-foreground))]" /><div><p className="font-mono text-sm">{job.respectRobotsTxt ? 'Enabled' : 'Disabled'}</p><p className="text-[10px] text-[hsl(var(--muted-foreground))]">robots.txt</p></div></div><div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] p-3"><LockKeyhole className="h-4 w-4 text-[hsl(var(--accent-foreground))]" /><div><p className="font-mono text-sm">Same origin</p><p className="text-[10px] text-[hsl(var(--muted-foreground))]">crawl boundary</p></div></div></div></section>
          <aside className="rounded-[1.35rem] border border-[hsl(var(--border))] bg-[hsl(var(--secondary)/.5)] p-6 md:p-7"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--card))] text-[hsl(var(--primary))]"><PauseCircle className="h-5 w-5" /></div><h2 className="mt-5 text-lg font-extrabold tracking-[-.03em]">A calm record of scope</h2><p className="mt-2 text-xs leading-5 text-[hsl(var(--muted-foreground))]">This job can only see what it was configured to see. The starting URL and crawl settings stay attached to the archive.</p><dl className="mt-6 space-y-4 border-t border-[hsl(var(--border))] pt-5 text-xs"><div className="flex justify-between gap-4"><dt className="text-[hsl(var(--muted-foreground))]">Starting URL</dt><dd className="max-w-[170px] truncate font-mono text-[10px]">{job.url}</dd></div><div className="flex justify-between gap-4"><dt className="text-[hsl(var(--muted-foreground))]">Page ceiling</dt><dd className="font-mono">{job.maxPages}</dd></div><div className="flex justify-between gap-4"><dt className="text-[hsl(var(--muted-foreground))]">Depth limit</dt><dd className="font-mono">{job.maxDepth}</dd></div><div className="flex justify-between gap-4"><dt className="text-[hsl(var(--muted-foreground))]">Path scope</dt><dd className="max-w-[170px] truncate font-mono">{job.pathPrefix}</dd></div><div className="flex justify-between gap-4"><dt className="text-[hsl(var(--muted-foreground))]">Assets</dt><dd className="font-mono">{job.includeAssets ? 'Included' : 'Skipped'}</dd></div><div className="flex justify-between gap-4"><dt className="text-[hsl(var(--muted-foreground))]">Finished</dt><dd className="font-mono text-[10px]">{formatDate(job.completedAt)}</dd></div></dl><div className="mt-6 flex gap-2 text-[10px] leading-4 text-[hsl(var(--muted-foreground))]"><LockKeyhole className="mt-0.5 h-3 w-3 shrink-0" />Only archive sites you own or have explicit permission to copy.</div></aside>
        </div>
        <footer className="mt-10 flex flex-col gap-3 border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center sm:justify-between"><span>Site Mirror · transparent by design</span><span className="font-mono tracking-[.1em]">JOB {job.id.slice(0, 8).toUpperCase()}</span></footer>
      </main>
    </div>
  );
}