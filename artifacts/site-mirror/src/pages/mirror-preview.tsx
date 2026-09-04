import { useEffect } from 'react';
import { ArrowLeft, CircleAlert, ExternalLink, LoaderCircle, Network, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { getGetMirrorJobQueryKey, useGetMirrorJob } from '@workspace/api-client-react';

function PreviewSkeleton() {
  return (
    <div className="mx-auto max-w-[1220px] animate-pulse px-5 py-8 md:px-10">
      <div className="h-4 w-28 rounded bg-[hsl(var(--muted))]" />
      <div className="mt-8 h-20 rounded-[1.35rem] bg-[hsl(var(--muted))]" />
      <div className="mt-6 h-[min(68dvh,720px)] rounded-[1.35rem] bg-[hsl(var(--muted))]" />
    </div>
  );
}

export default function MirrorPreviewPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const query = useGetMirrorJob(id, {
    query: {
      queryKey: getGetMirrorJobQueryKey(id),
      enabled: Boolean(id),
    },
  });
  const job =
    query.data &&
    typeof query.data === 'object' &&
    'id' in query.data &&
    'status' in query.data
      ? query.data
      : undefined;
  const previewUrl = `/api/mirror-jobs/${encodeURIComponent(id)}/preview`;
  const canPreview =
    job?.archiveAvailable &&
    (job.status === 'completed' || job.status === 'completed_with_warnings');

  useEffect(() => {
    document.title = job ? `Preview · ${(job.url ?? 'mirrored site').replace(/^https?:\/\//, '')}` : 'Mirror preview · Site Mirror';
  }, [job]);

  if (query.isLoading) {
    return (
      <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
        <PreviewSkeleton />
      </div>
    );
  }

  if (query.error || !job) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[hsl(var(--background))] px-5">
        <div className="w-full max-w-md rounded-[1.4rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-7 text-center shadow-[var(--shadow-md)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]">
            <CircleAlert className="h-5 w-5" />
          </div>
          <h1 className="mt-5 text-xl font-extrabold tracking-[-.03em]">This preview is out of reach</h1>
          <p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
            We could not find that mirror job or the control room is temporarily unavailable.
          </p>
          <Link
            href={`/jobs/${encodeURIComponent(id)}`}
            className="mt-6 inline-flex h-10 items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 text-xs font-bold text-[hsl(var(--primary-foreground))]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to job
          </Link>
        </div>
      </div>
    );
  }

  if (!canPreview) {
    return (
      <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
        <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
          <div className="mx-auto flex max-w-[1220px] items-center justify-between px-5 py-4 md:px-10">
            <Link href="/" className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]">
                <Network className="h-4 w-4" />
              </span>
              <span className="text-sm font-extrabold tracking-[-.03em]">site mirror</span>
            </Link>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.6)]">
              <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />
              authorized control room
            </div>
          </div>
        </header>
        <main className="mx-auto flex min-h-[calc(100dvh-73px)] max-w-[1220px] items-center justify-center px-5 py-10 md:px-10">
          <section className="w-full max-w-lg rounded-[1.5rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-8 text-center shadow-[var(--shadow-md)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">
              {job.status === 'queued' || job.status === 'running' ? (
                <LoaderCircle className="h-5 w-5 animate-spin" />
              ) : (
                <CircleAlert className="h-5 w-5" />
              )}
            </div>
            <h1 className="mt-5 text-2xl font-extrabold tracking-[-.04em]">
              {job.status === 'queued' || job.status === 'running'
                ? 'Preview will be ready soon'
                : 'Preview is not available'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
              {job.status === 'queued' || job.status === 'running'
                ? 'The mirrored site can be opened after the archive has been sealed.'
                : 'This mirror does not have a usable archive available to preview.'}
            </p>
            <Link
              href={`/jobs/${encodeURIComponent(id)}`}
              className="mt-7 inline-flex h-10 items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 text-xs font-bold text-[hsl(var(--primary-foreground))]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to job
            </Link>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
      <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
        <div className="mx-auto flex max-w-[1220px] items-center justify-between gap-4 px-5 py-4 md:px-10">
          <Link href={`/jobs/${encodeURIComponent(id)}`} className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]">
              <Network className="h-4 w-4" />
            </span>
            <span className="text-sm font-extrabold tracking-[-.03em]">site mirror</span>
          </Link>
          <div className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--primary-foreground)/.6)] sm:flex">
            <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />
            snapshot preview
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1220px] px-5 py-7 md:px-10 md:py-9">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <Link
            href={`/jobs/${encodeURIComponent(id)}`}
            className="inline-flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--primary))]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to job
          </Link>
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 text-xs font-bold text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--muted))]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in new tab
          </a>
        </div>

        <section className="overflow-hidden rounded-[1.5rem] border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[var(--shadow-lg)]">
          <div className="flex flex-col gap-4 border-b border-[hsl(var(--border))] px-5 py-5 sm:flex-row sm:items-center sm:justify-between md:px-7">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[hsl(var(--accent-foreground))]">Mirrored snapshot</p>
              <h1 className="mt-2 truncate text-xl font-extrabold tracking-[-.04em] md:text-2xl">{job.url ?? 'Mirrored site'}</h1>
              <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                Links and assets resolve from the sealed archive, not the live website.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-full bg-[hsl(var(--secondary))] px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-[hsl(var(--muted-foreground))]">
              <span className="h-1.5 w-1.5 rounded-full bg-[hsl(158_39%_42%)]" />
              read-only preview
            </div>
          </div>
          <div className="bg-[hsl(var(--muted)/.45)] p-2 sm:p-3">
            <iframe
              title={`Preview of ${job.url ?? 'mirrored site'}`}
              src={previewUrl}
              sandbox="allow-scripts allow-forms allow-downloads"
              className="h-[min(72dvh,780px)] w-full rounded-xl border border-[hsl(var(--border))] bg-white"
            />
          </div>
        </section>
      </main>
    </div>
  );
}