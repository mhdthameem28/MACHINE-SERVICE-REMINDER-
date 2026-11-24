import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Bell,
  Calculator,
  Factory,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  PackagePlus,
  Settings,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AuthProvider, AppUser, useAuth } from './context/AuthContext';
import {
  canAccessReports,
  canManageSettings,
  canReceiveOrAdjustStock,
  ROLE_LABELS,
} from './lib/roles';
import { LoginScreen } from './components/LoginScreen';
import { DashboardPage } from './pages/DashboardPage';
import { ReceiveStockPage } from './pages/ReceiveStockPage';
import { StockAdjustmentPage } from './pages/StockAdjustmentPage';
import { BulkStockUpdatePage } from './pages/BulkStockUpdatePage';
import { BatchesPage } from './pages/BatchesPage';
import { BatchDetailPage } from './pages/BatchDetailPage';
import { ScrapLogPage } from './pages/ScrapLogPage';
import { ReportsPage } from './pages/ReportsPage';
import { NotificationItem, NotificationsPage } from './pages/NotificationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SheetWeightCalculatorModal } from './components/SheetWeightCalculatorModal';
import { formatDateTime } from './lib/format';

type NavPage =
  | 'dashboard'
  | 'receive'
  | 'adjust'
  | 'bulk-update'
  | 'batches'
  | 'batch-detail'
  | 'scrap'
  | 'reports'
  | 'notifications'
  | 'settings';

function getDefaultRouteForRole(user: AppUser): NavPage {
  if (user.role === 'operator') return 'batches';
  return 'dashboard';
}

const WorkspaceShell: React.FC = () => {
  const { user, loading, logout, apiFetch } = useAuth();
  const [page, setPage] = useState<NavPage>('dashboard');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [receiveMaterialId, setReceiveMaterialId] = useState<number | undefined>(undefined);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [unreadCount, setUnreadCount] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);
  const [recentNotifications, setRecentNotifications] = useState<NotificationItem[]>([]);
  const [calculatorOpen, setCalculatorOpen] = useState(false);

  const refreshNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>(
        '/api/notifications'
      );
      setUnreadCount(res.unreadCount);
      setRecentNotifications(res.notifications.slice(0, 6));
    } catch {
      // Non-fatal background refresh
    }
  }, [apiFetch, user]);

  useEffect(() => {
    if (user) {
      setPage(getDefaultRouteForRole(user));
      refreshNotifications();
    }
  }, [user?.id]);

  const navigate = (target: string, params?: { batchId?: string; materialId?: number }) => {
    setMobileNavOpen(false);
    setBellOpen(false);
    if (target === 'batch-detail' && params?.batchId) {
      setSelectedBatchId(params.batchId);
      setPage('batch-detail');
      return;
    }
    if (target === 'receive') {
      setReceiveMaterialId(params?.materialId);
    }
    setPage(target as NavPage);
    refreshNotifications();
  };

  const handleMarkBellRead = async (id: number) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
      setRecentNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // Ignore
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen w-full bg-[#F8FAFC] font-sans items-center justify-center">
        <div className="px-5 py-3 rounded-2xl bg-white border border-slate-200 shadow-sm text-xs font-medium text-slate-600">
          Loading workspace...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onSignedIn={(signedInUser) => {
          setPage(getDefaultRouteForRole(signedInUser));
        }}
      />
    );
  }

  const navItems: {
    id: NavPage;
    label: string;
    icon: React.FC<{ className?: string }>;
    visible: boolean;
  }[] = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: LayoutDashboard,
      visible: true,
    },
    {
      id: 'receive',
      label: 'Receive Stock',
      icon: PackagePlus,
      visible: canReceiveOrAdjustStock(user.role),
    },
    {
      id: 'adjust',
      label: 'Stock Adjustment',
      icon: SlidersHorizontal,
      visible: canReceiveOrAdjustStock(user.role),
    },
    {
      id: 'bulk-update',
      label: 'Bulk Stock Update',
      icon: Upload,
      visible: canReceiveOrAdjustStock(user.role),
    },
    {
      id: 'batches',
      label: 'Batches',
      icon: Layers,
      visible: true,
    },
    {
      id: 'scrap',
      label: 'Scrap & Rejections',
      icon: Trash2,
      visible: true,
    },
    {
      id: 'reports',
      label: 'Reports',
      icon: BarChart3,
      visible: canAccessReports(user.role),
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      visible: true,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      visible: canManageSettings(user.role),
    },
  ];

  const pageLabels: Record<NavPage, string> = {
    dashboard: 'Dashboard',
    receive: 'Receive Stock',
    adjust: 'Stock Adjustment',
    'bulk-update': 'Bulk Stock Update',
    batches: 'Batches',
    'batch-detail': selectedBatchId ? `Batches / ${selectedBatchId}` : 'Batch Detail',
    scrap: 'Scrap & Rejections',
    reports: 'Reports',
    notifications: 'Notifications',
    settings: 'Settings',
  };

  const renderSidebarInner = (isMobileDrawer = false) => (
    <>
      <div className="h-16 px-4 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-sm">
            <Factory className="w-4 h-4 text-white" />
          </div>
          <span className="text-white font-bold text-sm leading-tight tracking-tight">
            Abone Cut Pieces Tracking
          </span>
        </div>
        {isMobileDrawer && (
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden p-1 text-slate-300 hover:text-white rounded"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems
          .filter((item) => item.visible)
          .map((item) => {
            const Icon = item.icon;
            const active =
              page === item.id || (item.id === 'batches' && page === 'batch-detail');
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                className={`w-full px-3.5 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between gap-2 transition-all whitespace-nowrap ${
                  active
                    ? 'bg-indigo-600 text-white shadow-[0_0_20px_-4px_rgba(79,70,229,0.7)]'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      active ? 'text-white' : 'text-slate-400'
                    }`}
                  />
                  <span>{item.label}</span>
                </span>
                {item.id === 'notifications' && unreadCount > 0 && (
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] tabular-nums font-semibold ${
                      active
                        ? 'bg-white/20 text-white'
                        : 'bg-rose-500/20 text-rose-200'
                    }`}
                  >
                    {unreadCount}
                  </span>
                )}
              </button>
            );
          })}
      </nav>

      <div className="p-4 border-t border-slate-800 bg-slate-900 text-xs shrink-0">
        <div className="font-semibold text-white truncate">{user.name}</div>
        <div className="text-slate-400 truncate mt-0.5">{user.email}</div>
        <div className="text-indigo-300 font-medium mt-1.5">
          {ROLE_LABELS[user.role]} · ID #{user.id}
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans">
      {/* SIDEBAR */}
      <aside className="hidden lg:flex w-64 bg-slate-900 text-slate-300 flex-col h-full border-r border-slate-800 shrink-0">
        {renderSidebarInner(false)}
      </aside>

      {/* Mobile/Tablet Sidebar Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-50 w-64 bg-slate-900 text-slate-300 flex flex-col h-full border-r border-slate-800">
            {renderSidebarInner(true)}
          </aside>
        </div>
      )}

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-[#F8FAFC]">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between gap-4 px-6 shrink-0 relative z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg hover:bg-slate-50"
              aria-label="Open navigation"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="text-sm font-medium text-slate-500 truncate">
              <span className="text-slate-900 font-semibold tracking-tight">Operations</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="text-slate-600 font-medium">{pageLabels[page]}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
            {/* Sheet Weight Calculator Trigger */}
            <button
              type="button"
              onClick={() => setCalculatorOpen(true)}
              title="Sheet Weight Calculator"
              aria-label="Open Sheet Weight Calculator"
              className="px-3 py-2 text-slate-600 hover:text-indigo-600 border border-slate-300 rounded-lg bg-white hover:bg-indigo-50/60 hover:border-indigo-300 transition-colors inline-flex items-center gap-1.5"
            >
              <Calculator className="w-4 h-4" />
              <span className="hidden md:inline text-xs font-medium">Weight Calc</span>
            </button>

            {/* Notification Bell + Panel */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  const next = !bellOpen;
                  setBellOpen(next);
                  if (next) refreshNotifications();
                }}
                aria-label="Notifications"
                className="relative p-2 text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="text-xs font-semibold tabular-nums text-red-600">
                    {unreadCount}
                  </span>
                )}
              </button>

              {bellOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white border border-slate-200 rounded-2xl shadow-lg z-30 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900">
                      Recent Notifications
                    </span>
                    <button
                      type="button"
                      onClick={() => navigate('notifications')}
                      className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      View all
                    </button>
                  </div>
                  <div className="divide-y divide-slate-200 max-h-80 overflow-y-auto">
                    {recentNotifications.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-500">
                        No notifications yet.
                      </div>
                    ) : (
                      recentNotifications.map((n) => (
                        <div
                          key={n.id}
                          className={`p-3 text-xs space-y-1 ${
                            n.isRead ? 'bg-white' : 'bg-indigo-50/40'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`font-semibold ${
                                n.type === 'reorder_alert'
                                  ? 'text-red-700'
                                  : 'text-slate-900'
                              }`}
                            >
                              {n.title}
                            </span>
                            {!n.isRead && (
                              <button
                                type="button"
                                onClick={() => handleMarkBellRead(n.id)}
                                className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 shrink-0"
                              >
                                Mark read
                              </button>
                            )}
                          </div>
                          <p className="text-slate-600 leading-relaxed">{n.message}</p>
                          <div className="text-[11px] text-slate-400 tabular-nums">
                            {formatDateTime(n.createdAt)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-600 whitespace-nowrap">
              <span className="font-medium text-slate-900">{user.name}</span>
              <span aria-hidden="true">·</span>
              <span>{ROLE_LABELS[user.role]}</span>
            </div>

            <button
              type="button"
              onClick={logout}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </header>

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-7xl w-full mx-auto">
            {page === 'dashboard' && <DashboardPage onNavigate={navigate} />}
            {page === 'receive' && canReceiveOrAdjustStock(user.role) && (
              <ReceiveStockPage
                initialMaterialId={receiveMaterialId}
                onOpenBatch={(batchId) => navigate('batch-detail', { batchId })}
                onOpenCalculator={() => setCalculatorOpen(true)}
              />
            )}
            {page === 'adjust' && canReceiveOrAdjustStock(user.role) && (
              <StockAdjustmentPage />
            )}
            {page === 'bulk-update' && canReceiveOrAdjustStock(user.role) && (
              <BulkStockUpdatePage />
            )}
            {page === 'batches' && (
              <BatchesPage
                onOpenBatch={(batchId) => navigate('batch-detail', { batchId })}
              />
            )}
            {page === 'batch-detail' && selectedBatchId && (
              <BatchDetailPage
                batchId={selectedBatchId}
                onBack={() => navigate('batches')}
                onOpenBatch={(id) => navigate('batch-detail', { batchId: id })}
              />
            )}
            {page === 'scrap' && (
              <ScrapLogPage
                onOpenBatch={(batchId) => navigate('batch-detail', { batchId })}
              />
            )}
            {page === 'reports' && canAccessReports(user.role) && <ReportsPage />}
            {page === 'notifications' && (
              <NotificationsPage
                onUnreadCountChange={setUnreadCount}
                onOpenBatch={(batchId) => navigate('batch-detail', { batchId })}
              />
            )}
            {page === 'settings' && canManageSettings(user.role) && <SettingsPage />}
          </div>
        </div>
      </main>

      <SheetWeightCalculatorModal
        open={calculatorOpen}
        onClose={() => setCalculatorOpen(false)}
      />
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <WorkspaceShell />
    </AuthProvider>
  );
}
