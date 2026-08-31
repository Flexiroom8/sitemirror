import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileArchive,
  Globe2,
  HardDrive,
  History,
  Layers3,
  LockKeyhole,
  Network,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  TimerReset,
  Waypoints,
} from 'lucide-react';
import {
  getGetMirrorJobQueryKey,
  type MirrorJob,
  type MirrorJobInput,
  useCreateMirrorJob,
  useGetMirrorJob,
} from '@workspace/api-client-react';
import { formatBytes, formatDate } from '@/lib/mirror-format';

const defaultForm: Required<MirrorJobInput> = {
  url: '',
  maxPages: 100,
  requestDelayMs: 250,
  respectRobotsTxt: true,
  maxDepth: 3,
  includeAssets: true,
  pathPrefix: '/',
  excludePaths: [],
  timeoutMs: 900_000,
  maxTotalBytes: 524_288_000,
};


function SiteMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] shadow-sm">
        <Network className="h-[18px] w-[18px]" strokeWidth={2.3} />
        <span className="signal-dot absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[hsl(var(--card))]" />
      </div>
      {!compact && (
        <div>
          <p className="text-[15px] font-extrabold tracking-[-0.03em]">site mirror</p>
          <p className="font-mono text-[9px] uppercase tracking-[.2em] text-[hsl(var(--sidebar-foreground)/.56)]">controlled archive</p>
        </div>
      )}
    </div>
  );
}

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

function RecentJob({ job, isLoading, isError }: { job?: MirrorJob; isLoading: boolean; isError: boolean }) {
  if (isLoading) {
    return <div className="animate-pulse space-y-3"><div className="h-4 w-28 rounded bg-[hsl(var(--muted))]" /><div className="h-16 rounded-xl bg-[hsl(var(--muted))]" /></div>;
  }
  if (isError) {
    return <div className="rounded-xl border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.07)] p-4 text-sm text-[hsl(var(--destructive))]">The latest job could not be loaded. Your new configuration is still ready.</div>;
  }
  if (!job) {
    return <div className="rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/.42)] p-5"><div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))]"><FileArchive className="h-4 w-4" /></div><p className="text-sm font-semibold">No mirror jobs yet</p><p className="mt-1 max-w-sm text-xs leading-5 text-[hsl(var(--muted-foreground))]">Your most recent archive will appear here once you start a crawl.</p></div>;
  }
  return (
    <Link href={`/jobs/${job.id}`} data-testid={`link-latest-job-${job.id}`} className="group block rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[hsl(var(--accent-border))] hover:shadow-[var(--shadow-sm)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{job.url.replace(/^https?:\/\//, '')}</p>
          <p className="mt-1 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{formatDate(job.createdAt)} · {job.pagesDownloaded} pages · {formatBytes(job.bytesDownloaded)}</p>
        </div>
        <StatusPill status={job.status} />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[hsl(var(--border))] pt-3 text-xs font-semibold text-[hsl(var(--primary))]"><span>Open job monitor</span><ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" /></div>
    </Link>
  );
}

export default function MirrorHome() {
  const [, setLocation] = useLocation();
  const [form, setForm] = useState(defaultForm);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [excludePathsText, setExcludePathsText] = useState('');
  const [validationError, setValidationError] = useState('');
  const [latestJobId] = useState<string | null>(() => {
    try { return window.localStorage.getItem('site-mirror:last-job'); } catch { return null; }
  });
  const latestQuery = useGetMirrorJob(latestJobId ?? '', {
    query: { enabled: Boolean(latestJobId), queryKey: getGetMirrorJobQueryKey(latestJobId ?? '') },
  });
  const createJob = useCreateMirrorJob();
  const latestJob = latestQuery.data;
  const createError = createJob.error as { error?: string } | null;
  const formReady = useMemo(() => form.url.trim().length > 0 && form.maxPages >= 1 && form.maxPages <= 1000 && form.requestDelayMs >= 0 && form.maxDepth >= 0 && form.maxDepth <= 10 && form.pathPrefix.trim().length > 0 && form.timeoutMs >= 60_000 && form.timeoutMs <= 3_600_000 && form.maxTotalBytes >= 1_048_576 && form.maxTotalBytes <= 2_147_483_648, [form]);

  useEffect(() => {
    document.title = 'New mirror · Site Mirror';
  }, []);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError('');
    let parsed: URL;
    try { parsed = new URL(form.url.trim()); } catch { setValidationError('Enter a complete website address, including https://.'); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { setValidationError('Only HTTP and HTTPS websites can be mirrored.'); return; }
    const excludePaths = excludePathsText.split(',').map((value) => value.trim()).filter(Boolean);
    if (excludePaths.length > 10) { setValidationError('Add no more than 10 excluded paths.'); return; }
    if (!formReady) { setValidationError('Check the page limit, depth, path scope, and request delay before starting.'); return; }
    createJob.mutate({ data: { ...form, url: parsed.toString(), excludePaths } }, {
      onSuccess: (job) => {
        try { window.localStorage.setItem('site-mirror:last-job', job.id); } catch { /* storage can be unavailable */ }
        setLocation(`/jobs/${job.id}`);
      },
    });
  };

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
      <aside className="hidden min-h-[100dvh] w-[248px] flex-col justify-between bg-[hsl(var(--sidebar))] px-5 py-6 text-[hsl(var(--sidebar-foreground))] md:flex md:fixed md:inset-y-0 md:left-0">
        <div>
          <SiteMark />
          <div className="mt-14">
            <p className="mb-3 px-3 font-mono text-[9px] uppercase tracking-[.22em] text-[hsl(var(--sidebar-foreground)/.46)]">Workspace</p>
            <div className="flex items-center gap-3 rounded-xl bg-[hsl(var(--sidebar-accent))] px-3 py-3 text-sm font-semibold shadow-inner"><ScanSearch className="h-4 w-4 text-[hsl(var(--accent))]" />New mirror</div>
            <Link href="/history" data-testid="link-history" className="mt-2 flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-[hsl(var(--sidebar-foreground)/.7)] transition-colors hover:bg-[hsl(var(--sidebar-accent)/.6)] hover:text-[hsl(var(--sidebar-foreground))]"><History className="h-4 w-4" />Job history</Link>
          </div>
          <div className="mt-10 border-t border-[hsl(var(--sidebar-border))] pt-7">
            <p className="mb-3 px-3 font-mono text-[9px] uppercase tracking-[.22em] text-[hsl(var(--sidebar-foreground)/.46)]">Operating principles</p>
            <div className="space-y-4 px-3 text-xs leading-5 text-[hsl(var(--sidebar-foreground)/.66)]">
              <p className="flex gap-2.5"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--accent))]" />Same-origin by default</p>
              <p className="flex gap-2.5"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--accent))]" />Robots-aware crawling</p>
              <p className="flex gap-2.5"><BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--accent))]" />A clear record of scope</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent)/.52)] p-3.5">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold"><CircleHelp className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />Need a refresher?</div>
          <p className="text-[11px] leading-4 text-[hsl(var(--sidebar-foreground)/.57)]">Only archive sites you own or have explicit permission to copy.</p>
        </div>
      </aside>

      <main className="md:ml-[248px]">
        <header className="flex items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.88)] px-5 py-4 backdrop-blur md:px-10">
          <div className="md:hidden"><SiteMark compact /></div>
          <div className="hidden items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] md:flex"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(157_43%_40%)]" />Control room / New mirror</div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--muted-foreground))]"><span className="hidden sm:inline">Local archive protocol</span><span className="h-1 w-1 rounded-full bg-[hsl(var(--accent))]" />ready</div>
        </header>

        <div className="mx-auto max-w-[1260px] px-5 py-8 md:px-10 md:py-12">
          <section className="animate-rise-in relative overflow-hidden rounded-[1.6rem] bg-[hsl(var(--primary))] px-6 py-8 text-[hsl(var(--primary-foreground))] shadow-[var(--shadow-lg)] md:px-10 md:py-11">
            <div className="mesh-bg absolute inset-0 opacity-40" />
            <div className="relative max-w-2xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[hsl(var(--primary-foreground)/.2)] bg-[hsl(var(--primary-foreground)/.07)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.16em] text-[hsl(var(--primary-foreground)/.75)]"><Waypoints className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />A transparent crawl, start to finish</div>
              <h1 className="max-w-2xl text-4xl font-extrabold leading-[1.06] tracking-[-.055em] md:text-6xl">Make a local copy.<br /><span className="text-[hsl(var(--accent))]">Know exactly what happened.</span></h1>
              <p className="mt-5 max-w-xl text-sm leading-6 text-[hsl(var(--primary-foreground)/.68)] md:text-base">Configure a respectful mirror of a site you own or are authorized to archive. Watch every page and asset come in, without guessing what the crawler is doing.</p>
            </div>
            <div className="absolute -bottom-16 -right-8 hidden h-48 w-48 rounded-full border border-[hsl(var(--accent)/.25)] md:block"><div className="absolute inset-7 rounded-full border border-[hsl(var(--accent)/.35)]"><div className="absolute inset-7 rounded-full bg-[hsl(var(--accent)/.11)]" /></div></div>
          </section>

          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_350px]">
            <section className="animate-rise-in-delay rounded-[1.35rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-[var(--shadow-sm)] md:p-8">
              <div className="mb-7 flex items-start justify-between gap-4">
                <div><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--accent-foreground))]">01 / define scope</p><h2 className="mt-2 text-2xl font-extrabold tracking-[-.04em]">New mirror job</h2><p className="mt-1.5 text-sm text-[hsl(var(--muted-foreground))]">Start at a single URL. We stay on its origin.</p></div>
                <div className="hidden h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))] sm:flex"><SlidersHorizontal className="h-4 w-4" /></div>
              </div>
              <form onSubmit={submit} className="space-y-6">
                <div>
                  <label htmlFor="mirror-url" className="mb-2 flex items-center justify-between text-xs font-bold"><span>Starting URL</span><span className="font-mono text-[10px] font-normal text-[hsl(var(--muted-foreground))]">required</span></label>
                  <div className="relative"><Globe2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input id="mirror-url" data-testid="input-mirror-url" value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="https://your-site.example" className="h-12 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] pl-10 pr-4 text-sm outline-none transition-colors placeholder:text-[hsl(var(--muted-foreground)/.72)] focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /></div>
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]"><LockKeyhole className="h-3 w-3" />Authorization required. This tool is for permitted archives only.</p>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div><label htmlFor="max-pages" className="mb-2 block text-xs font-bold">Page limit</label><div className="relative"><Layers3 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input id="max-pages" data-testid="input-max-pages" type="number" min={1} max={1000} value={form.maxPages} onChange={(event) => update('maxPages', Number(event.target.value))} className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] pl-10 pr-4 text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /></div><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">1–1,000 pages per job</p></div>
                  <div><label htmlFor="request-delay" className="mb-2 block text-xs font-bold">Request delay</label><div className="relative"><TimerReset className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input id="request-delay" data-testid="input-request-delay" type="number" min={0} max={5000} step={50} value={form.requestDelayMs} onChange={(event) => update('requestDelayMs', Number(event.target.value))} className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] pl-10 pr-16 text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /><span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">ms</span></div><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">A pause between requests</p></div>
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.42)] p-4 transition-colors hover:border-[hsl(var(--accent-border))]"><input data-testid="input-respect-robots" type="checkbox" checked={form.respectRobotsTxt} onChange={(event) => update('respectRobotsTxt', event.target.checked)} className="peer sr-only" /><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--card))] text-transparent peer-checked:border-[hsl(var(--accent-border))] peer-checked:bg-[hsl(var(--accent))] peer-checked:text-[hsl(var(--accent-foreground))]"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span><span><span className="block text-xs font-bold">Respect robots.txt</span><span className="mt-1 block text-[11px] leading-4 text-[hsl(var(--muted-foreground))]">Skip paths disallowed by the site’s crawler policy.</span></span></label>
                <button type="button" onClick={() => setAdvancedOpen((open) => !open)} className="flex w-full items-center justify-between rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 text-left transition-colors hover:border-[hsl(var(--accent-border))]"><span><span className="block text-xs font-bold">Advanced crawl controls</span><span className="mt-1 block text-[11px] text-[hsl(var(--muted-foreground))]">Limit depth, scope paths, and asset collection.</span></span><ChevronDown className={`h-4 w-4 text-[hsl(var(--muted-foreground))] transition-transform ${advancedOpen ? 'rotate-180' : ''}`} /></button>
                {advancedOpen && <div className="grid gap-5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.28)] p-4 sm:grid-cols-2">
                  <div><label htmlFor="max-depth" className="mb-2 block text-xs font-bold">Maximum link depth</label><input id="max-depth" type="number" min={0} max={10} value={form.maxDepth} onChange={(event) => update('maxDepth', Number(event.target.value))} className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-4 text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">0 stays on the starting page</p></div>
                  <div><label htmlFor="path-prefix" className="mb-2 block text-xs font-bold">Path prefix</label><input id="path-prefix" value={form.pathPrefix} onChange={(event) => update('pathPrefix', event.target.value)} placeholder="/" className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-4 font-mono text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">Only crawl paths under this prefix</p></div>
                  <div><label htmlFor="time-limit" className="mb-2 block text-xs font-bold">Time limit</label><div className="relative"><Clock3 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input id="time-limit" data-testid="input-time-limit" type="number" min={1} max={60} value={Math.round(form.timeoutMs / 60_000)} onChange={(event) => update('timeoutMs', Math.round(Number(event.target.value)) * 60_000)} className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] pl-10 pr-16 text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /><span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">min</span></div><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">1–60 minutes for the whole crawl</p></div>
                  <div><label htmlFor="size-cap" className="mb-2 block text-xs font-bold">Size cap</label><div className="relative"><HardDrive className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input id="size-cap" data-testid="input-size-cap" type="number" min={1} max={2048} value={Math.round(form.maxTotalBytes / 1_048_576)} onChange={(event) => update('maxTotalBytes', Math.round(Number(event.target.value)) * 1_048_576)} className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] pl-10 pr-16 text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /><span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">MB</span></div><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">Stops the mirror once the archive reaches this size</p></div>
                  <div className="sm:col-span-2"><label htmlFor="exclude-paths" className="mb-2 block text-xs font-bold">Exclude paths <span className="font-normal text-[hsl(var(--muted-foreground))]">(comma separated)</span></label><input id="exclude-paths" value={excludePathsText} onChange={(event) => setExcludePathsText(event.target.value)} placeholder="/admin, /private, /drafts" className="h-11 w-full rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-4 font-mono text-sm outline-none focus:border-[hsl(var(--accent-border))] focus:ring-2 focus:ring-[hsl(var(--accent)/.18)]" /><p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">Up to 10 path prefixes will be skipped.</p></div>
                  <label className="sm:col-span-2 flex cursor-pointer items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3.5"><input type="checkbox" checked={form.includeAssets} onChange={(event) => update('includeAssets', event.target.checked)} className="peer sr-only" /><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] text-transparent peer-checked:border-[hsl(var(--accent-border))] peer-checked:bg-[hsl(var(--accent))] peer-checked:text-[hsl(var(--accent-foreground))]"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span><span><span className="block text-xs font-bold">Collect same-origin assets</span><span className="mt-1 block text-[11px] text-[hsl(var(--muted-foreground))]">Download images, scripts, stylesheets, and media referenced by each page.</span></span></label>
                </div>}
                {(validationError || createError) && <div data-testid="status-create-error" className="rounded-xl border border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.07)] px-4 py-3 text-xs font-semibold text-[hsl(var(--destructive))]">{validationError || createError?.error || 'The mirror could not be started. Check the URL and try again.'}</div>}
                <button data-testid="button-start-mirror" type="submit" disabled={createJob.isPending} className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] text-sm font-bold text-[hsl(var(--primary-foreground))] shadow-[0_5px_0_hsl(196_47%_14%)] transition-transform hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-wait disabled:opacity-70">{createJob.isPending ? <><RefreshCw className="h-4 w-4 animate-spin" />Preparing mirror...</> : <>Start authorized mirror <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" /></>}</button>
              </form>
            </section>

            <aside className="space-y-6">
              <section className="rounded-[1.35rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-[var(--shadow-sm)]">
                <div className="mb-4 flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--accent-foreground))]">02 / latest activity</p><Clock3 className="h-4 w-4 text-[hsl(var(--muted-foreground))]" /></div>
                <RecentJob job={latestJob} isLoading={latestQuery.isLoading} isError={Boolean(latestQuery.error)} />
              </section>
              <section className="rounded-[1.35rem] border border-[hsl(var(--border))] bg-[hsl(var(--secondary)/.52)] p-5">
                <div className="mb-4 flex items-center gap-2.5"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--card))] text-[hsl(var(--primary))]"><ShieldCheck className="h-4 w-4" /></div><h3 className="text-sm font-extrabold">The safety boundary</h3></div>
                <div className="space-y-3 text-xs leading-5 text-[hsl(var(--muted-foreground))]"><p>Site Mirror follows links within the starting site only. External references are recorded, never crawled.</p><p>Each request is delayed and every job keeps its scope visible, so you can stop it at any point.</p></div>
                <div className="mt-5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[.13em] text-[hsl(var(--primary))]"><ExternalLink className="h-3 w-3" />permission-first archiving</div>
              </section>
            </aside>
          </div>
          <footer className="mt-10 flex flex-col gap-3 border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center sm:justify-between"><span>Site Mirror keeps the crawl legible.</span><span className="font-mono tracking-[.1em]">HTTP · SAME ORIGIN · ROBOTS AWARE</span></footer>
        </div>
      </main>
    </div>
  );
}