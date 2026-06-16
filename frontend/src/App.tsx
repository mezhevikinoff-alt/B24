import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { MonthPicker } from './components/MonthPicker';
import { ScheduleModule } from './modules/Schedule';
import { ConversionModule } from './modules/Conversion';
import { SummaryModule } from './modules/Summary';
import { formatMonthRu } from './utils/dates';

type Tab = 'schedule' | 'conversion' | 'summary';

function Inner() {
  const { isReady, currentUser } = useApp();
  const [tab, setTab] = useState<Tab>('schedule');
  const [date, setDate] = useState(new Date());

  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="text-4xl mb-3">⏳</div>
          <div className="text-gray-500 font-medium">Загрузка...</div>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'schedule', label: 'График работы', icon: '📅' },
    { id: 'conversion', label: 'Конверсия лидов', icon: '🎯' },
    { id: 'summary', label: 'Сводный отчёт', icon: '📊' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-20">
        <div className="max-w-full px-4 py-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold text-sm tracking-wide">
              ОРК
            </div>
            <h1 className="text-gray-800 font-bold text-lg hidden sm:block">
              Отдел по работе с клиентами
            </h1>
            <span className="text-gray-400 text-sm hidden md:block">— Отчёты</span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <MonthPicker value={date} onChange={setDate} />
            {currentUser && (
              <span className="text-sm text-gray-500 hidden lg:block">
                {currentUser.LAST_NAME} {currentUser.NAME}
              </span>
            )}
          </div>
        </div>

        {/* Tabs */}
        <nav className="px-4 flex gap-1 border-t border-gray-100">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
              }`}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* Period label */}
      <div className="px-4 pt-3 pb-1">
        <span className="text-xs text-gray-400 uppercase font-semibold tracking-wider">
          {formatMonthRu(year, month)}
        </span>
      </div>

      {/* Content */}
      <main className="flex-1">
        {tab === 'schedule' && <ScheduleModule year={year} month={month} />}
        {tab === 'conversion' && <ConversionModule year={year} month={month} />}
        {tab === 'summary' && <SummaryModule year={year} month={month} />}
      </main>

      <footer className="px-4 py-2 text-xs text-gray-400 text-center border-t border-gray-100 bg-white">
        ОРК — Отчёты · {new Date().getFullYear()}
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Inner />
    </AppProvider>
  );
}
