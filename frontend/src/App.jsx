import { useState } from 'react';
import Navbar from './components/Navbar.jsx';
import SearchTab from './components/SearchTab.jsx';
import CacheMonitorTab from './components/CacheMonitorTab.jsx';
import TrendingTab from './components/TrendingTab.jsx';
import BatchWriterTab from './components/BatchWriterTab.jsx';

const TABS = [
  { id: 'search',  label: 'Search',        emoji: '🔍' },
  { id: 'cache',   label: 'Cache Monitor',  emoji: '📦' },
  { id: 'trending',label: 'Trending',       emoji: '🔥' },
  { id: 'batch',   label: 'Batch Writer',   emoji: '📋' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('search');

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <main className="flex-1 pt-20">
        {activeTab === 'search'   && <SearchTab />}
        {activeTab === 'cache'    && <CacheMonitorTab />}
        {activeTab === 'trending' && <TrendingTab />}
        {activeTab === 'batch'    && <BatchWriterTab />}
      </main>
    </div>
  );
}
