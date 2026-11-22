import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { canAdvanceBatch } from '../lib/roles';
import { formatDateTime, formatWithUnit } from '../lib/format';

interface BatchDetailData {
  batch: {
    id: string;
    materialId: number;
    materialCode: string;
    materialName: string;
    materialUnit: string;
    currentStageId: number;
    stageName: string;
    stageSequence: number;
    quantity: number;
    note: string | null;
    createdAt: string;
    createdByName: string;
    createdByEmail: string;
  };
  history: {
    id: number;
    stageId: number;
    stageName: string;
    stageSequence: number;
    movedAt: string;
    movedByName: string;
    movedByEmail: string;
    note: string | null;
  }[];
  activeStages: {
    id: number;
    name: string;
    sequence: number;
    active: boolean;
  }[];
  nextStage: {
    id: number;
    name: string;
    sequence: number;
  } | null;
}

interface BatchDetailPageProps {
  batchId: string;
  onBack: () => void;
}

export const BatchDetailPage: React.FC<BatchDetailPageProps> = ({ batchId, onBack }) => {
  const { user, apiFetch } = useAuth();
  const [data, setData] = useState<BatchDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [advancing, setAdvancing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadBatch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<BatchDetailData>(`/api/batches/${encodeURIComponent(batchId)}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch details');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, batchId]);

  useEffect(() => {
    loadBatch();
  }, [loadBatch]);

  const handleAdvance = async () => {
    if (!data?.nextStage) return;
    setAdvancing(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        fromStage: { name: string };
        toStage: { name: string };
        reorderAlertTriggered: boolean;
      }>(`/api/batches/${encodeURIComponent(batchId)}/advance`, {
        method: 'POST',
        body: JSON.stringify({ note: note.trim() || undefined }),
      });

      setFeedback(
        `Batch advanced from ${res.fromStage.name} to ${res.toStage.name}.${
          res.reorderAlertTriggered ? ' Reorder alert triggered.' : ''
        }`
      );
      setNote('');
      await loadBatch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to advance stage');
    } finally {
      setAdvancing(false);
    }
  };

  if (loading) {
    return <div className="h-96 bg-white border border-slate-200 rounded-lg animate-pulse" />;
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Batches</span>
        </button>
        <div className="p-4 bg-white border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { batch, history, activeStages, nextStage } = data;
  const userCanAdvance = user ? canAdvanceBatch(user.role) : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Batches</span>
          </button>
          <h2 className="text-xl font-bold font-mono text-slate-900">{batch.id}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-mono">{batch.materialCode}</span>
            <span aria-hidden="true">·</span>
            <span>{batch.materialName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums font-medium text-slate-800">
              {formatWithUnit(batch.quantity, batch.materialUnit)}
            </span>
            <span aria-hidden="true">·</span>
            <span>Created by {batch.createdByName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{formatDateTime(batch.createdAt)}</span>
          </div>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Visual Stage Progression Timeline */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Production Stage Timeline</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Current stage:{' '}
              <span className="font-semibold text-slate-900">
                {String(batch.stageSequence).padStart(2, '0')}. {batch.stageName}
              </span>
            </p>
          </div>

          {userCanAdvance && nextStage && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Transition note (optional)"
                className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-400 w-56"
              />
              <button
                type="button"
                onClick={handleAdvance}
                disabled={advancing}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <span>
                  {advancing ? 'Advancing...' : `Advance to ${nextStage.name}`}
                </span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!nextStage && (
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="w-4 h-4" />
              <span>Final active stage reached</span>
            </div>
          )}
        </div>

        {/* Stepper */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {activeStages.map((st) => {
            const historyEntry = history.find((h) => h.stageId === st.id);
            const isCurrent = batch.currentStageId === st.id;
            const isCompleted = st.sequence < batch.stageSequence || (isCurrent && !nextStage);

            return (
              <div
                key={st.id}
                className={`border rounded-md p-3.5 transition-colors ${
                  isCurrent
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : isCompleted || historyEntry
                    ? 'border-emerald-200 bg-emerald-50/40 text-slate-900'
                    : 'border-slate-200 bg-slate-50/40 text-slate-500'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-xs ${
                      isCurrent ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    Stage {String(st.sequence).padStart(2, '0')}
                  </span>
                  {isCurrent ? (
                    <Clock className="w-3.5 h-3.5 text-white shrink-0" />
                  ) : historyEntry ? (
                    <Check className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                  ) : null}
                </div>
                <div className="mt-1 text-sm font-semibold truncate">{st.name}</div>
                <div
                  className={`mt-2 text-xs font-mono tabular-nums ${
                    isCurrent ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {historyEntry ? formatDateTime(historyEntry.movedAt) : 'Pending'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Full Stage History Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Stage Transition History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                <th className="px-4 py-2.5">Sequence</th>
                <th className="px-4 py-2.5">Stage</th>
                <th className="px-4 py-2.5">Timestamp (UTC)</th>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {history.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-slate-600">
                    {String(h.stageSequence).padStart(2, '0')}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{h.stageName}</td>
                  <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-slate-700">
                    {formatDateTime(h.movedAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="text-slate-900">{h.movedByName}</div>
                    <div className="text-xs text-slate-500">{h.movedByEmail}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{h.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
