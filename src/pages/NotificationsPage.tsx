import React, { useEffect, useState } from 'react';
import { Bell, Check, CheckCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../lib/format';

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  emailSent: boolean;
  emailRecipientsCount: number;
  isRead: boolean;
  createdAt: string;
}

interface NotificationsPageProps {
  onUnreadCountChange: (count: number) => void;
  onOpenBatch?: (batchId: string) => void;
}

export const NotificationsPage: React.FC<NotificationsPageProps> = ({
  onUnreadCountChange,
  onOpenBatch,
}) => {
  const { apiFetch } = useAuth();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadNotifications = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>(
        '/api/notifications'
      );
      setItems(res.notifications);
      onUnreadCountChange(res.unreadCount);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNotifications();
  }, []);

  const markRead = async (id: number) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
      const next = items.map((n) => (n.id === id ? { ...n, isRead: true } : n));
      setItems(next);
      onUnreadCountChange(next.filter((n) => !n.isRead).length);
    } catch {
      // Ignore transient error
    }
  };

  const markAllRead = async () => {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
      const next = items.map((n) => ({ ...n, isRead: true }));
      setItems(next);
      onUnreadCountChange(0);
    } catch {
      // Ignore transient error
    }
  };

  const visible = filter === 'unread' ? items.filter((n) => !n.isRead) : items;

  if (loading) {
    return <div className="h-72 bg-white border border-slate-200 rounded-2xl shadow-sm animate-pulse" />;
  }

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Notifications</h1>
          <p className="text-sm text-slate-500 mt-1">
            Reorder threshold alerts and batch stage completion updates.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex p-1 bg-white border border-slate-200 rounded-xl shadow-sm">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                filter === 'all' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('unread')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                filter === 'unread' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Unread ({items.filter((n) => !n.isRead).length})
            </button>
          </div>

          <button
            type="button"
            onClick={markAllRead}
            disabled={items.every((n) => n.isRead)}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 inline-flex items-center gap-1.5 shadow-sm"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            <span>Mark all read</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm divide-y divide-slate-200 overflow-hidden">
        {visible.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Bell className="w-6 h-6 text-slate-400 mx-auto mb-2" />
            <p className="text-sm font-medium text-slate-900">No notifications</p>
            <p className="text-xs text-slate-500 mt-1">
              {filter === 'unread'
                ? 'All caught up — no unread alerts.'
                : 'Alerts appear here when stock hits reorder levels or batches advance.'}
            </p>
          </div>
        ) : (
          visible.map((n) => (
            <div
              key={n.id}
              className={`p-4 flex items-start justify-between gap-4 transition-colors ${
                n.isRead ? 'bg-transparent hover:bg-slate-50' : 'bg-indigo-50/50 hover:bg-indigo-50/80'
              }`}
            >
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span
                    className={`font-semibold ${
                      n.type === 'reorder_alert' ? 'text-red-700' : 'text-slate-900'
                    }`}
                  >
                    {n.type === 'reorder_alert' ? 'Reorder Alert' : 'Stage Update'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{formatDateTime(n.createdAt)}</span>
                  {n.type === 'reorder_alert' && n.emailRecipientsCount > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {n.emailSent
                          ? `Emailed ${n.emailRecipientsCount} recipient(s)`
                          : `${n.emailRecipientsCount} email recipient(s) queued`}
                      </span>
                    </>
                  )}
                  {!n.isRead && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-semibold">
                        Unread
                      </span>
                    </>
                  )}
                </div>
                <div className="text-sm font-semibold text-slate-900">{n.title}</div>
                <p className="text-xs text-slate-600">{n.message}</p>
                {n.entityType === 'batch' && n.entityId && onOpenBatch && (
                  <button
                    type="button"
                    onClick={() => onOpenBatch(n.entityId!)}
                    className="mt-1 text-xs font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
                  >
                    Inspect {n.entityId}
                  </button>
                )}
              </div>

              {!n.isRead && (
                <button
                  type="button"
                  onClick={() => markRead(n.id)}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1 shrink-0"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Mark read</span>
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
