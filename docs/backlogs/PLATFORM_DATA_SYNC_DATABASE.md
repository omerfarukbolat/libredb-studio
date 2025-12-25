# LibreDB Studio - Platform Mimarisi

> **Durum:** Backlog  
> **Tarih:** 2025-12-25  
> **Öncelik:** Yüksek

---

## 1. Çalışma Modları

Sistem **iki modda** çalışabilir. Her iki durumda da hatasız çalışır:

### 1.1 Browser-Only Mode (Default)

```
┌─────────────────────────────────────────┐
│  PGlite (WASM PostgreSQL)               │
│         │                               │
│         ▼                               │
│  IndexedDB (tarayıcı)                   │
│                                         │
│  ✅ External DB gerekmez                │
│  ✅ Zero-config, hemen çalışır          │
│  ✅ Tek tarayıcıda kullanım             │
└─────────────────────────────────────────┘
```

- Platform verileri **sadece tarayıcıda** kalır
- External database **gerekmez**
- Kurulum veya konfigürasyon **gerekmez**
- Tarayıcı temizlenirse veriler **kaybolur**

### 1.2 Database Sync Mode (Opsiyonel)

```
┌─────────────────────────────────────────┐
│  PGlite (WASM PostgreSQL)               │
│         │                               │
│         ▼                               │
│  IndexedDB (tarayıcı)                   │
│         │                               │
│         ▼ (sync enabled)                │
│  ElectricSQL ──▶ External PostgreSQL    │
│                                         │
│  ✅ Veriler hem tarayıcıda hem DB'de    │
│  ✅ Birden fazla cihazda erişim         │
│  ✅ Tarayıcı temizlense bile geri gelir │
└─────────────────────────────────────────┘
```

- Platform verileri **önce tarayıcıda**, sonra **external DB'ye sync**
- Kullanıcı isterse açar, **zorunlu değil**
- Offline çalışmaya **devam eder**
- Veriler **kalıcı** ve **paylaşılabilir**

### 1.3 Mod Seçimi

| Parametre | Değer | Davranış |
|-----------|-------|----------|
| `SYNC_MODE` veya UI ayarı | `browser` (default) | Sadece tarayıcı |
| `SYNC_MODE` veya UI ayarı | `database` | Tarayıcı + sync |

```typescript
// Örnek kullanım
if (syncConfig.enabled && syncConfig.databaseUrl) {
  await startSync(); // External DB'ye sync başlat
}
// else: Sadece PGlite, hata yok
```

---

## 2. İhtiyaç Analizi

### 2.1 Temel İhtiyaçlar

| # | İhtiyaç | Açıklama |
|---|---------|----------|
| 1 | **User/Role Management** | Kullanıcı oluşturma, rol atama (admin, user, viewer) |
| 2 | **Query Logging** | Kullanıcı bazlı sorgu geçmişi (query, row count, execution time, status) |
| 3 | **Saved Queries** | Kullanıcıların sorgularını kaydetmesi, düzenlemesi |
| 4 | **Account Management** | Profil, tercihler, hesap ayarları |
| 5 | **Platform Yapısı** | İleride ortak çalışma alanı, paylaşım özellikleri |

### 2.2 Teknik Gereksinimler

| Gereksinim | Açıklama |
|------------|----------|
| Zero-config başlangıç | Kurulum gerektirmeden çalışmalı |
| Veritabanı ihtiyacı | User, query logs, saved queries için kalıcı depolama |
| Opsiyonel kalıcılık | İsteyen kullanıcı verilerini external DB'ye sync edebilmeli |
| Minimal karmaşıklık | Mevcut mimariyi fazla değiştirmemeli |

### 2.3 Mevcut Sorunlar

- LocalStorage 5-10MB limiti
- Kullanıcı bazlı ayrım yok
- Cihazlar arası veri paylaşımı yok
- Tarayıcı temizlenince veri kaybı

---

## 3. Çözüm: PGlite + ElectricSQL

### 3.1 Vizyon

```
Default:   Tarayıcıda PGlite (WASM PostgreSQL) → IndexedDB'de kalıcı
Optional:  Kullanıcı isterse → External PostgreSQL'e sync (ElectricSQL)
```

### 3.2 Neden Bu Çözüm?

| Alternatif | Sorun |
|------------|-------|
| LocalStorage | 5-10MB limit, SQL yok |
| IndexedDB (raw) | NoSQL, karmaşık query'ler zor |
| External DB zorunlu | Zero-config olmaz, kurulum gerekir |
| **PGlite** | ✅ Gerçek PostgreSQL, 100GB+ limit, zero-config |

### 3.3 Mimari

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│                                                              │
│   React Components                                           │
│         │                                                    │
│         ▼                                                    │
│   storage.ts (API değişmez)                                  │
│         │                                                    │
│         ▼                                                    │
│   PGlite (WASM PostgreSQL)                                   │
│         │                                                    │
│         ▼                                                    │
│   IndexedDB (100GB+ limit)                                   │
│         │                                                    │
│         ▼ (opsiyonel)                                        │
│   ElectricSQL Sync ──────────▶ External PostgreSQL           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Önemli:** Mevcut `storage.ts` API'si korunur, sadece backend değişir.

---

## 4. Veritabanı Şeması

### 4.1 Tablolar

```sql
-- Users
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',  -- admin, user, viewer
    preferences JSONB DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Connections (şifreler hariç - localStorage'da kalır)
CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL,  -- postgres, mysql, sqlite, mongodb, demo
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Query History
CREATE TABLE query_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    connection_id TEXT,
    connection_name TEXT,
    tab_name TEXT,
    query TEXT NOT NULL,
    row_count INTEGER,
    execution_time_ms INTEGER,
    status TEXT NOT NULL,  -- success, error
    error_message TEXT,
    executed_at TEXT DEFAULT (datetime('now'))
);

-- Saved Queries
CREATE TABLE saved_queries (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    query TEXT NOT NULL,
    connection_type TEXT,
    tags TEXT,  -- JSON array as text
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Sync Config (opsiyonel)
CREATE TABLE sync_config (
    id TEXT PRIMARY KEY,
    sync_enabled INTEGER DEFAULT 0,
    sync_url TEXT,
    last_sync_at TEXT
);
```

---

## 5. Uygulama Planı

### 5.1 Dosya Yapısı (Minimal)

```
src/lib/
├── storage.ts           # Mevcut API korunur, PGlite backend
├── pglite/
│   ├── client.ts        # PGlite singleton
│   ├── migrations.ts    # Schema migrations
│   └── sync.ts          # ElectricSQL entegrasyonu (Phase 2)
└── crypto/
    └── vault.ts         # Şifre encryption (localStorage)
```

### 5.2 Phase 1: PGlite Entegrasyonu (1 hafta)

**Hedef:** LocalStorage → PGlite geçişi

| Task | Açıklama |
|------|----------|
| PGlite client | Singleton instance, lazy loading |
| Migrations | Initial schema, version tracking |
| storage.ts refactor | Aynı API, PGlite backend |
| Data migration | Mevcut localStorage verilerini PGlite'a taşı |

**storage.ts değişimi:**

```typescript
// ÖNCE
export const storage = {
  getHistory: () => {
    const stored = localStorage.getItem(HISTORY_KEY);
    return JSON.parse(stored);
  }
};

// SONRA
export const storage = {
  getHistory: async () => {
    const db = await getPGlite();
    const result = await db.query('SELECT * FROM query_logs ORDER BY executed_at DESC');
    return result.rows;
  }
};
```

### 5.3 Phase 2: User Management (1 hafta)

**Hedef:** Gerçek kullanıcı sistemi

| Task | Açıklama |
|------|----------|
| User CRUD | Create, read, update users |
| Auth integration | Mevcut JWT sistemi ile bağlantı |
| Role-based queries | Kullanıcı bazlı veri filtreleme |
| Settings UI | Kullanıcı tercihleri sayfası |

### 5.4 Phase 3: ElectricSQL Sync (1 hafta)

**Hedef:** Opsiyonel external sync

| Task | Açıklama |
|------|----------|
| Electric client | Sync client setup |
| Sync UI | Bağlantı formu, status indicator |
| Conflict handling | Last-write-wins |

---

## 6. API Uyumluluğu

**Mevcut API korunur, sadece async olur:**

```typescript
// Mevcut kullanım (Dashboard.tsx)
storage.addToHistory(item);
const history = storage.getHistory();

// Yeni kullanım (minimal değişiklik)
await storage.addToHistory(item);
const history = await storage.getHistory();
```

**Dashboard.tsx değişimi minimal:**
- `storage.xxx()` → `await storage.xxx()`
- useEffect içinde async wrapper

---

## 7. Güvenlik

| Veri | Depolama | Sync |
|------|----------|------|
| Şifreler | localStorage (encrypted) | ❌ Asla |
| Kullanıcı bilgileri | PGlite | ✅ Opsiyonel |
| Query history | PGlite | ✅ Opsiyonel |
| Saved queries | PGlite | ✅ Opsiyonel |

---

## 8. Bağımlılıklar

```json
{
  "@electric-sql/pglite": "^0.2.x"
}
```

**Not:** ElectricSQL sync client Phase 3'te eklenecek.

---

## 9. Zaman Çizelgesi

| Phase | Süre | Çıktı |
|-------|------|-------|
| Phase 1: PGlite | 5-7 gün | LocalStorage → PGlite geçişi |
| Phase 2: Users | 5-7 gün | Kullanıcı yönetimi |
| Phase 3: Sync | 5-7 gün | Opsiyonel external sync |

**Toplam:** ~3 hafta

---

## 10. Özet

```
İhtiyaç                    →  Çözüm
─────────────────────────────────────────────────
User/Role Management       →  users tablosu + role column
Query Logging             →  query_logs tablosu
Saved Queries             →  saved_queries tablosu
Account Management        →  users.preferences JSONB
Platform (gelecek)        →  ElectricSQL sync ile
Zero-config               →  PGlite (tarayıcı içi)
Opsiyonel kalıcılık       →  ElectricSQL → External PostgreSQL
```

---

## 11. Referanslar

- [PGlite](https://pglite.dev/) - Browser-içi PostgreSQL
- [ElectricSQL](https://electric-sql.com/) - Postgres sync
