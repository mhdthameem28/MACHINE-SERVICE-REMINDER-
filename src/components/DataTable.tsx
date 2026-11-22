import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';

export interface ColumnDef<T> {
  key: string;
  label: string;
  numeric?: boolean;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  render?: (row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  keyField: (row: T) => string | number;
  searchPlaceholder?: string;
  searchFilter?: (row: T, query: string) => boolean;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  hideSearch?: boolean;
}

export function DataTable<T>({
  data,
  columns,
  keyField,
  searchPlaceholder = 'Search records...',
  searchFilter,
  onRowClick,
  rowClassName,
  pageSize = 12,
  emptyTitle = 'No records found',
  emptyDescription = 'Try adjusting your filters or adding a new entry.',
  emptyAction,
  hideSearch = false,
}: DataTableProps<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !searchFilter) return data;
    return data.filter((row) => searchFilter(row, q));
  }, [data, search, searchFilter]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sortValue ? col.sortValue(a) : (a as Record<string, unknown>)[col.key];
      const bv = col.sortValue ? col.sortValue(b) : (b as Record<string, unknown>)[col.key];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = String(av ?? '');
      const bs = String(bv ?? '');
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
  }, [filtered, columns, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleSort = (col: ColumnDef<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
    setPage(1);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      {!hideSearch && searchFilter && (
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50/50">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={searchPlaceholder}
              className="w-full pl-9 pr-3 py-1.5 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400"
            />
          </div>
          <div className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
            {sorted.length} {sorted.length === 1 ? 'record' : 'records'}
          </div>
        </div>
      )}

      {paginated.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm font-medium text-slate-900">{emptyTitle}</p>
          <p className="text-xs text-slate-500 mt-1">{emptyDescription}</p>
          {emptyAction && <div className="mt-4">{emptyAction}</div>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70">
                {columns.map((col) => {
                  const isSorted = sortKey === col.key;
                  const canSort = col.sortable !== false;
                  return (
                    <th
                      key={col.key}
                      className={`px-4 py-2.5 text-xs font-semibold text-slate-600 select-none whitespace-nowrap ${
                        col.numeric ? 'text-right' : 'text-left'
                      }`}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={() => handleSort(col)}
                          className={`inline-flex items-center gap-1.5 hover:text-slate-900 transition-colors ${
                            col.numeric ? 'flex-row-reverse' : ''
                          }`}
                        >
                          <span>{col.label}</span>
                          {isSorted ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="w-3.5 h-3.5 text-slate-900" />
                            ) : (
                              <ArrowDown className="w-3.5 h-3.5 text-slate-900" />
                            )
                          ) : (
                            <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {paginated.map((row) => {
                const extraClass = rowClassName ? rowClassName(row) : '';
                return (
                  <tr
                    key={keyField(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`${
                      onRowClick ? 'cursor-pointer hover:bg-slate-50' : 'hover:bg-slate-50/60'
                    } transition-colors ${extraClass}`}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-2.5 text-slate-800 ${
                          col.numeric ? 'text-right font-mono tabular-nums' : 'text-left'
                        }`}
                      >
                        {col.render
                          ? col.render(row)
                          : String((row as Record<string, unknown>)[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between text-xs text-slate-600">
          <span className="tabular-nums">
            Page {safePage} of {totalPages}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="px-2.5 py-1 border border-slate-200 bg-white rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="px-2.5 py-1 border border-slate-200 bg-white rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
