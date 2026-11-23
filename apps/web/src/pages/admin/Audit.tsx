import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { useState } from "react";
import { AUDIT_ACTIONS } from "@waitless/shared";
import { CardEmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api } from "@/lib/api";

interface AuditLog {
  id: string;
  actorUserId: string;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

interface AuditData {
  items: AuditLog[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  filters: { entity: string | null; action: string | null; actorUserId: string | null; from: string | null; to: string | null };
}

const PAGE_SIZES = ["20", "50", "100"];

function formatTime(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function shortId(value: string | null) {
  return value ? `${value.slice(0, 8)}${value.length > 8 ? "…" : ""}` : "—";
}

export function AuditPage() {
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (entity.trim()) params.set("entity", entity.trim());
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();

  const auditQ = useQuery({
    queryKey: ["admin", "audit", query],
    queryFn: async () => (await api.get<{ data: AuditData }>(`/admin/audit?${query}`)).data,
    retry: false,
  });

  const data = auditQ.data;
  const meta = data?.meta ?? { page, pageSize, total: 0, totalPages: 1 };
  const rows = data?.items ?? [];

  function resetPage() {
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="A read-only trail of administrative and queue actions, newest first."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>Narrow the trail by entity, action, actor and hospital-local date range.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="audit-entity">Entity</Label>
              <Input
                id="audit-entity"
                value={entity}
                placeholder="Appointment"
                onChange={(event) => {
                  setEntity(event.target.value);
                  resetPage();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-action">Action</Label>
              <Select
                value={action}
                onValueChange={(value) => {
                  setAction(value === "all" ? "" : value);
                  resetPage();
                }}
              >
                <SelectTrigger id="audit-action" aria-label="Filter by action">
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {AUDIT_ACTIONS.map((item) => (
                    <SelectItem key={item} value={item}>{item.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-from">From</Label>
              <Input
                id="audit-from"
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  resetPage();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-to">To</Label>
              <Input
                id="audit-to"
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  resetPage();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-page-size">Rows per page</Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value));
                  resetPage();
                }}
              >
                <SelectTrigger id="audit-page-size" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((size) => <SelectItem key={size} value={size}>{size}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="p-0">
        <CardHeader className="p-4 pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-base">Recent entries</CardTitle>
              <CardDescription>{meta.total} matching entries across the selected range.</CardDescription>
            </div>
            <Badge variant="muted">Page {meta.page} of {meta.totalPages}</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {auditQ.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading audit log…</p>
          ) : auditQ.isError ? (
            <div className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between" role="alert">
              <p className="text-sm text-muted-foreground">
                {auditQ.error instanceof ApiError ? auditQ.error.message : "Could not load the audit log"}
              </p>
              <Button variant="outline" size="sm" onClick={() => void auditQ.refetch()}>Try again</Button>
            </div>
          ) : rows.length === 0 ? (
            <CardEmptyState icon={ScrollText} title="No audit entries" description="Try widening the filters or date range." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatTime(row.createdAt)}</TableCell>
                      <TableCell>
                        <span className="block text-sm">{row.actorName ?? "System"}</span>
                        <span className="block text-xs text-muted-foreground" title={row.actorUserId}>{shortId(row.actorUserId)}</span>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="whitespace-nowrap">{row.action.replace(/_/g, " ")}</Badge></TableCell>
                      <TableCell>
                        <span className="block text-sm">{row.entity}</span>
                        <span className="block text-xs text-muted-foreground" title={row.entityId ?? undefined}>{shortId(row.entityId)}</span>
                      </TableCell>
                      <TableCell>
                        <details className="text-xs">
                          <summary className="cursor-pointer font-medium text-primary">View changes</summary>
                          <pre className="mt-2 max-h-40 max-w-80 overflow-auto rounded-md bg-muted/40 p-2 text-[11px]">
                            {JSON.stringify({ before: row.before, after: row.after }, null, 2)}
                          </pre>
                        </details>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length} of {meta.total} entries
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous audit page"
            disabled={page <= 1 || auditQ.isLoading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="size-4" />Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next audit page"
            disabled={!data || page >= meta.totalPages || auditQ.isLoading}
            onClick={() => setPage((current) => current + 1)}
          >
            Next<ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
