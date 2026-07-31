import { type FormEvent, useCallback, useEffect, useState } from "react";
import { jsonBody } from "../api/client.ts";
import type {
  EndpointOverrideDetailResponse,
  EndpointOverrideListResponse,
  EndpointOverrideUpsertResponse,
  ServerRequest,
  SuitesResponse,
} from "../api/types.ts";
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
  Tag,
  TextInput,
} from "../ui/index.tsx";

type EndpointRow = {
  relativePath: string;
};

type EndpointOverrideSummary = {
  baseUrl: string | null;
};

export function EndpointsView({ request }: { request: ServerRequest }) {
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [overrideMap, setOverrideMap] = useState<
    Record<string, EndpointOverrideSummary>
  >({});
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [nextSuites, nextOverrides] = await Promise.all([
        request<SuitesResponse>("/api/suites"),
        request<EndpointOverrideListResponse>("/api/endpoint-overrides"),
      ]);
      setSuites(nextSuites);
      const next: Record<string, EndpointOverrideSummary> = {};
      for (const item of nextOverrides.overrides) {
        next[item.endpoint_path] = {
          baseUrl: item.base_url,
        };
      }
      setOverrideMap(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        await loadAll();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  if (error && !suites) return <ErrorBanner message={error} />;
  if (!suites) return <Loading />;

  const endpointSuites: EndpointRow[] = suites.suites
    .filter((suite) => suite.schema === "endpoints")
    .map((suite) => ({ relativePath: suite.relativePath }));

  const overriddenCount = endpointSuites.filter((row) => {
    const entry = overrideMap[row.relativePath];
    return Boolean(entry?.baseUrl);
  }).length;

  return (
    <>
      <PageHeader
        eyebrow="Endpoints"
        title="Endpoint overrides"
        meta={`${endpointSuites.length} endpoint${endpointSuites.length === 1 ? "" : "s"} · ${overriddenCount} with overrides`}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <p className="text-sm text-muted-foreground mb-4">
        Override values from any endpoint YAML. Saved overrides are applied
        whenever the dashboard server uses that endpoint, taking precedence over
        the YAML defaults (and any <code>${"{VAR}"}</code> placeholders).
      </p>
      {endpointSuites.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          No endpoint suites found in your data path.
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {endpointSuites.map((row) => (
            <EndpointOverrideCard
              key={row.relativePath}
              relativePath={row.relativePath}
              request={request}
              onChanged={() => {
                void loadAll();
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function EndpointOverrideCard({
  relativePath,
  request,
  onChanged,
}: {
  relativePath: string;
  request: ServerRequest;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<EndpointOverrideDetailResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await request<EndpointOverrideDetailResponse>(
        `/api/endpoint-overrides/${encodeURIComponent(relativePath)}`,
      );
      setDetail(next);
      setDraftBaseUrl(next.override?.base_url ?? "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [relativePath, request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        await load();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const trimmedBaseUrl = draftBaseUrl.trim();
      const response = await request<EndpointOverrideUpsertResponse>(
        `/api/endpoint-overrides/${encodeURIComponent(relativePath)}`,
        jsonBody("PUT", {
          base_url: trimmedBaseUrl || null,
        }),
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              override: trimmedBaseUrl ? response.override : null,
            }
          : prev,
      );
      setMessage(trimmedBaseUrl ? "Saved." : "Cleared.");
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onClear = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      await request<{ removed: boolean }>(
        `/api/endpoint-overrides/${encodeURIComponent(relativePath)}`,
        jsonBody("DELETE"),
      );
      setDraftBaseUrl("");
      setDetail((prev) => (prev ? { ...prev, override: null } : prev));
      setMessage("Cleared.");
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const hasSavedOverride = Boolean(detail?.override?.base_url);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm break-all">{relativePath}</span>
          {detail?.defaults.transport ? (
            <Tag tone="info">{detail.defaults.transport}</Tag>
          ) : null}
          {hasSavedOverride ? <Tag tone="warn">override saved</Tag> : null}
        </div>
      </div>
      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <form onSubmit={onSave} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label="YAML default"
              hint={
                detail?.defaults.base_url &&
                detail.defaults.base_url_resolved &&
                detail.defaults.base_url !== detail.defaults.base_url_resolved
                  ? `Resolves to ${detail.defaults.base_url_resolved}`
                  : "From the endpoint YAML's connection.base_url / connection.url"
              }
            >
              <TextInput
                value={detail?.defaults.base_url ?? ""}
                readOnly
                disabled
                className="font-mono text-xs"
              />
            </Field>
            <Field
              label="Override"
              hint="Applied for every run that uses this endpoint. Leave blank to remove."
            >
              <TextInput
                value={draftBaseUrl}
                onChange={(event) => setDraftBaseUrl(event.currentTarget.value)}
                placeholder={
                  detail?.defaults.base_url_resolved ??
                  "https://staging.example"
                }
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
            {hasSavedOverride ? (
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  void onClear();
                }}
              >
                Clear override
              </Button>
            ) : null}
            {message ? (
              <span className="text-xs text-success">{message}</span>
            ) : null}
            {error ? (
              <span className="text-xs text-destructive">{error}</span>
            ) : null}
          </div>
        </form>
      )}
    </Card>
  );
}
