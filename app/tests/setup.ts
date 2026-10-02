// 全局测试环境准备。
// 原先在此注入 fake-indexeddb/auto 供 Dexie 使用；数据已全量迁移到 REST /api/*，
// 剩余用例均为纯计算测试，不再需要 IndexedDB 垫片。
