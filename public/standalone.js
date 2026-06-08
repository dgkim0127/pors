(function () {
  function showFatal(message) {
    var rootNode = document.getElementById("root");
    if (rootNode) rootNode.textContent = "오류: " + message;
  }
  window.addEventListener("error", function (event) {
    showFatal((event.error && event.error.message) || event.message || "알 수 없는 오류");
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var message = reason && reason.message ? reason.message : String(reason || "알 수 없는 오류");
    showFatal(message);
  });

  if (!window.React || !window.ReactDOM) {
    document.getElementById("root").textContent = "앱을 불러오지 못했습니다. 인터넷 연결을 확인하거나 APK 빌드로 실행해 주세요.";
    return;
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      registrations.forEach(function (registration) { registration.unregister(); });
    }).catch(function () {});
  }
  var h = React.createElement;
  var root = ReactDOM.createRoot(document.getElementById("root"));
  var STORE_KEY = "piercing-pos-state-v5";
  var DATA_VERSION = 23;
  var AUTH_KEY = "piercing-pos-auth-v1";
  var LOGIN_LOCK_KEY = "piercing-pos-login-lock-v1";
  var RECENT_CUSTOMERS_KEY = "piercing-pos-recent-customers-v1";
  var MANUAL_CUSTOMER_ID = "customer_manual";
  var AUTH_TTL_MS = 12 * 60 * 60 * 1000;
  var MAX_TEXT_LENGTH = 40;
  var MAX_PRICE = 99999999;
  var MAX_QUANTITY = 999;
  var MAX_SALES = 500;
  var KRW = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
  var firebaseDb = null;
  var firebasePersistenceTried = false;
  var splitCloudSaveTimer = null;
  var splitCloudSavePending = null;
  var splitCloudLastSignature = "";
  var splitCloudLastSignatures = {};
  var quickCloudSaveInFlight = false;
  var quickCloudSavePending = null;

  function notifyCloudStatus(status) {
    try {
      window.dispatchEvent(new CustomEvent("pors-cloud-status", { detail: { status: status } }));
    } catch (error) {}
  }

  function won(value) {
    return KRW.format(Math.round(Number(value) || 0));
  }

  function num(value) {
    var parsed = Number(String(value == null ? "" : value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, num(value)));
  }

  function safeText(value) {
    return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_TEXT_LENGTH);
  }

  function customerSearchKey(value) {
    return safeText(value).toLowerCase().replace(/\s+/g, "");
  }

  function readRecentCustomers() {
    try {
      var parsed = JSON.parse(localStorage.getItem(RECENT_CUSTOMERS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 8) : [];
    } catch (error) {
      return [];
    }
  }

  function saveRecentCustomers(ids) {
    try {
      localStorage.setItem(RECENT_CUSTOMERS_KEY, JSON.stringify((ids || []).filter(Boolean).slice(0, 8)));
    } catch (error) {}
  }

  window.PORS_BACK_HANDLERS = window.PORS_BACK_HANDLERS || [];
  function registerMobileBackHandler(handler) {
    window.PORS_BACK_HANDLERS.push(handler);
    return function () {
      var index = window.PORS_BACK_HANDLERS.indexOf(handler);
      if (index >= 0) window.PORS_BACK_HANDLERS.splice(index, 1);
    };
  }
  window.PorsHandleBack = function () {
    var handlers = window.PORS_BACK_HANDLERS || [];
    for (var index = handlers.length - 1; index >= 0; index -= 1) {
      try {
        if (handlers[index]()) return true;
      } catch (error) {
        console.warn("뒤로가기 처리 중 오류가 발생했습니다.", error);
      }
    }
    return false;
  };
  if (!window.__PORS_BROWSER_BACK_READY__) {
    window.__PORS_BROWSER_BACK_READY__ = true;
    try {
      window.history.replaceState({ porsRoot: true }, "", window.location.href);
      window.history.pushState({ porsBackGuard: true }, "", window.location.href);
      window.addEventListener("popstate", function () {
        window.PorsHandleBack();
        window.history.pushState({ porsBackGuard: true }, "", window.location.href);
      });
    } catch (error) {}
  }

  function saveState(state) {
    var now = Date.now();
    var safeState = Object.assign({}, state, {
      clientUpdatedAt: now,
      sales: (state.sales || []).slice(0, MAX_SALES)
    });
    localStorage.setItem(STORE_KEY, JSON.stringify(safeState));
  }

  function firebaseDatabase() {
    var config = window.PIERCE_FIREBASE_CONFIG || {};
    if (!config.apiKey || !window.firebase || !window.firebase.firestore) return null;
    try {
      if (!window.firebase.apps || !window.firebase.apps.length) {
        window.firebase.initializeApp(config);
      }
      if (!firebaseDb) {
        firebaseDb = window.firebase.firestore();
        if (!firebasePersistenceTried && firebaseDb.enablePersistence) {
          firebasePersistenceTried = true;
          firebaseDb.enablePersistence({ synchronizeTabs: true }).catch(function () {});
        }
      }
      return firebaseDb;
    } catch (error) {
      console.warn("Firebase 연결을 초기화하지 못했습니다.", error);
      return null;
    }
  }

  function firebaseDocument() {
    var db = firebaseDatabase();
    if (!db) return null;
    return db.collection(window.PIERCE_FIREBASE_COLLECTION || "piercing_pos").doc(window.PIERCE_FIREBASE_DOC || "pors_state");
  }

  function firebaseCollection(name) {
    var db = firebaseDatabase();
    return db ? db.collection(name) : null;
  }

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      return num(a.sort) - num(b.sort) || String(a.name || a.createdAt || "").localeCompare(String(b.name || b.createdAt || ""));
    });
  }

  function docsToRows(snapshot) {
    return snapshot.docs.map(function (doc) {
      var data = doc.data() || {};
      return Object.assign({ id: doc.id }, data);
    });
  }

  function cleanRemoteRow(row) {
    var copy = Object.assign({}, row);
    delete copy.categoryName;
    delete copy.groupKey;
    delete copy.displayPath;
    delete copy.cloudUpdatedAt;
    return copy;
  }

  function categoryNameMap(categories) {
    var map = {};
    (categories || []).forEach(function (category) { map[category.id] = category.name; });
    return map;
  }

  function groupDocId(group) {
    return group.id || [group.categoryId || "category", safeText(group.name || "none") || "none"].join("__").replace(/[\/#?[\]]/g, "_");
  }

  function enrichItemForCloud(item, categories) {
    var names = categoryNameMap(categories);
    var groupName = safeText(item.groupName || "");
    return Object.assign({}, item, {
      categoryName: names[item.categoryId] || "",
      groupName: groupName,
      groupKey: groupName || "없음",
      displayPath: [names[item.categoryId] || item.categoryId || "", groupName, item.name || ""].filter(Boolean).join(" / ")
    });
  }

  function commitBatchOperations(db, operations) {
    var chain = Promise.resolve();
    for (var start = 0; start < operations.length; start += 450) {
      (function (chunk) {
        chain = chain.then(function () {
          var batch = db.batch();
          chunk.forEach(function (operation) {
            if (operation.type === "delete") batch.delete(operation.ref);
            if (operation.type === "set") batch.set(operation.ref, operation.data, { merge: false });
          });
          return batch.commit();
        });
      })(operations.slice(start, start + 450));
    }
    return chain;
  }

  function replaceCollection(name, rows, docIdForRow) {
    var db = firebaseDatabase();
    var collection = firebaseCollection(name);
    if (!db || !collection) return Promise.resolve(false);
    return collection.get().then(function (snapshot) {
      var now = Date.now();
      var operations = [];
      snapshot.docs.forEach(function (doc) {
        operations.push({ type: "delete", ref: doc.ref });
      });
      rows.forEach(function (row) {
        var rowId = String(docIdForRow ? docIdForRow(row) : row.id || id(name));
        operations.push({
          type: "set",
          ref: collection.doc(rowId),
          data: Object.assign({}, clone(row), { id: rowId, cloudUpdatedAt: now, dataVersion: DATA_VERSION })
        });
      });
      return commitBatchOperations(db, operations).then(function () { return true; });
    });
  }

  function deleteCollection(name) {
    var db = firebaseDatabase();
    var collection = firebaseCollection(name);
    if (!db || !collection) return Promise.resolve(false);
    return collection.get().then(function (snapshot) {
      var operations = snapshot.docs.map(function (doc) {
        return { type: "delete", ref: doc.ref };
      });
      return commitBatchOperations(db, operations).then(function () { return true; });
    }).catch(function () {
      return false;
    });
  }

  function pullSplitCloudState() {
    var categoryCollection = firebaseCollection("categories");
    var groupCollection = firebaseCollection("subcategories");
    var itemCollection = firebaseCollection("items");
    var customerCollection = firebaseCollection("customers");
    var writerCollection = firebaseCollection("writers");
    var saleCollection = firebaseCollection("sales");
    if (!categoryCollection || !groupCollection || !itemCollection || !customerCollection || !writerCollection || !saleCollection) {
      return Promise.resolve(null);
    }
    return Promise.all([
      categoryCollection.get(),
      groupCollection.get(),
      itemCollection.get(),
      customerCollection.get(),
      writerCollection.get(),
      saleCollection.get()
    ]).then(function (results) {
      var hasSplitData = !results[0].empty || !results[2].empty || !results[3].empty || !results[4].empty || !results[5].empty;
      if (!hasSplitData) return null;
      var allRows = [];
      results.forEach(function (snapshot) {
        allRows = allRows.concat(docsToRows(snapshot));
      });
      var cloudUpdatedAt = allRows.reduce(function (latest, row) { return Math.max(latest, num(row.cloudUpdatedAt)); }, 0);
      var cloudDataVersion = allRows.reduce(function (latest, row) { return Math.max(latest, num(row.dataVersion)); }, 0);
      return {
        store: seed.store,
        categories: sortRows(docsToRows(results[0]).map(cleanRemoteRow)),
        groups: sortRows(docsToRows(results[1]).map(cleanRemoteRow)),
        items: sortRows(docsToRows(results[2]).map(cleanRemoteRow)),
        customers: sortRows(docsToRows(results[3]).map(cleanRemoteRow)),
        writers: sortRows(docsToRows(results[4]).map(cleanRemoteRow)),
        sales: docsToRows(results[5]).map(cleanRemoteRow).sort(function (a, b) { return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""); }).slice(0, MAX_SALES),
        clientUpdatedAt: cloudUpdatedAt,
        dataVersion: cloudDataVersion || 14
      };
    }).catch(function (error) {
      console.warn("Firebase 분리 데이터를 불러오지 못했습니다.", error);
      return null;
    });
  }

  function pullCloudState() {
    var docRef = firebaseDocument();
    if (!docRef) return pullSplitCloudState();
    return docRef.get().then(function (snapshot) {
      if (!snapshot.exists) return null;
      var data = snapshot.data() || {};
      return data.state || null;
    }).then(function (documentState) {
      if (documentState) {
        splitCloudLastSignature = splitCloudSignature(documentState);
        splitCloudLastSignatures = splitCloudCollectionSignatures(documentState);
      }
      return documentState || pullSplitCloudState();
    }).catch(function (error) {
      console.warn("Firebase 데이터를 불러오지 못했습니다.", error);
      return pullSplitCloudState();
    });
  }

  function syncSplitCloudState(cloudState) {
    var categories = sortRows(cloudState.categories || []);
    var groups = sortRows(cloudState.groups || []);
    var items = sortRows(cloudState.items || []).map(function (item) { return enrichItemForCloud(item, categories); });
    var customers = sortRows(cloudState.customers || []);
    var writers = sortRows(cloudState.writers || []);
    var signatures = splitCloudCollectionSignatures(cloudState);
    var operations = [];
    function syncIfChanged(key, operation) {
      if (signatures[key] === splitCloudLastSignatures[key]) return;
      operations.push(operation().then(function (result) {
        splitCloudLastSignatures[key] = signatures[key];
        return result;
      }));
    }
    syncIfChanged("categories", function () { return replaceCollection("categories", categories); });
    syncIfChanged("groups", function () { return replaceCollection("subcategories", groups, groupDocId); });
    syncIfChanged("items", function () { return replaceCollection("items", items); });
    syncIfChanged("customers", function () { return replaceCollection("customers", customers); });
    syncIfChanged("writers", function () { return replaceCollection("writers", writers); });
    return Promise.all(operations);
  }

  function splitCloudCollectionSignatures(cloudState) {
    return {
      categories: JSON.stringify(cloudState.categories || []),
      groups: JSON.stringify(cloudState.groups || []),
      items: JSON.stringify(cloudState.items || []),
      customers: JSON.stringify(cloudState.customers || []),
      writers: JSON.stringify(cloudState.writers || [])
    };
  }

  function splitCloudSignature(cloudState) {
    return JSON.stringify([
      cloudState.categories || [],
      cloudState.groups || [],
      cloudState.items || [],
      cloudState.customers || [],
      cloudState.writers || []
    ]);
  }

  function upsertSaleDocument(sale) {
    var collection = firebaseCollection("sales");
    if (!collection || !sale || !sale.id) return Promise.resolve(false);
    notifyCloudStatus("saving");
    return collection.doc(String(sale.id)).set(Object.assign({}, clone(sale), {
      id: String(sale.id),
      cloudUpdatedAt: Date.now(),
      dataVersion: DATA_VERSION
    }), { merge: false }).then(function () {
      notifyCloudStatus("synced");
      return true;
    }).catch(function (error) {
      console.warn("Firebase 판매 내역을 저장하지 못했습니다.", error);
      notifyCloudStatus("error");
      return false;
    });
  }

  function managementCollectionName(key) {
    return key === "groups" ? "subcategories" : key;
  }

  function managementDocId(key, row) {
    return key === "groups" ? groupDocId(row) : String(row && row.id || id(key));
  }

  function prepareManagementRow(key, row, state) {
    var data = clone(row);
    if (key === "items") data = enrichItemForCloud(data, state.categories || []);
    return data;
  }

  function upsertManagementDocument(key, row, state) {
    var collection = firebaseCollection(managementCollectionName(key));
    if (!collection || !row || !row.id) return Promise.resolve(false);
    var rowId = managementDocId(key, row);
    notifyCloudStatus("saving");
    return collection.doc(rowId).set(Object.assign({}, prepareManagementRow(key, row, state || {}), {
      id: rowId,
      cloudUpdatedAt: Date.now(),
      dataVersion: DATA_VERSION
    }), { merge: false }).then(function () {
      notifyCloudStatus("synced");
      return true;
    }).catch(function (error) {
      console.warn("Firebase 관리 항목을 저장하지 못했습니다.", key, error);
      notifyCloudStatus("error");
      return false;
    });
  }

  function deleteManagementDocument(key, row) {
    var collection = firebaseCollection(managementCollectionName(key));
    if (!collection || !row) return Promise.resolve(false);
    var rowId = typeof row === "string" ? row : managementDocId(key, row);
    notifyCloudStatus("saving");
    return collection.doc(String(rowId)).delete().then(function () {
      notifyCloudStatus("synced");
      return true;
    }).catch(function (error) {
      console.warn("Firebase 관리 항목을 삭제하지 못했습니다.", key, error);
      notifyCloudStatus("error");
      return false;
    });
  }

  function syncManagementDiff(previousState, nextState) {
    if (!firebaseDatabase()) return;
    ["categories", "groups", "items", "customers", "writers"].forEach(function (key) {
      var previousRows = previousState[key] || [];
      var nextRows = nextState[key] || [];
      var previousById = {};
      var nextById = {};
      previousRows.forEach(function (row) { if (row && row.id) previousById[row.id] = row; });
      nextRows.forEach(function (row) { if (row && row.id) nextById[row.id] = row; });
      previousRows.forEach(function (row) {
        if (row && row.id && !nextById[row.id]) deleteManagementDocument(key, row);
      });
      nextRows.forEach(function (row) {
        if (!row || !row.id) return;
        var previous = previousById[row.id];
        if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) upsertManagementDocument(key, row, nextState);
      });
    });
  }

  function deleteSaleDocument(saleId) {
    var collection = firebaseCollection("sales");
    if (!collection || !saleId) return Promise.resolve(false);
    notifyCloudStatus("saving");
    return collection.doc(String(saleId)).delete().then(function () {
      notifyCloudStatus("synced");
      return true;
    }).catch(function (error) {
      console.warn("Firebase 판매 내역을 삭제하지 못했습니다.", error);
      notifyCloudStatus("error");
      return false;
    });
  }

  function upsertDeletionLog(log) {
    var collection = firebaseCollection("deletion_logs");
    if (!collection || !log || !log.id) return Promise.resolve(false);
    return collection.doc(String(log.id)).set(Object.assign({}, clone(log), {
      id: String(log.id),
      cloudUpdatedAt: Date.now(),
      dataVersion: DATA_VERSION
    }), { merge: false }).catch(function (error) {
      console.warn("Firebase 삭제 기록을 저장하지 못했습니다.", error);
      return false;
    });
  }

  function subscribeDeletionLogs(onLogs) {
    var collection = firebaseCollection("deletion_logs");
    if (!collection || typeof collection.onSnapshot !== "function") return function () {};
    return collection.orderBy("deletedAt", "desc").limit(200).onSnapshot(function (snapshot) {
      onLogs(docsToRows(snapshot).map(cleanRemoteRow).sort(function (a, b) {
        return Date.parse(b.deletedAt || "") - Date.parse(a.deletedAt || "");
      }));
    }, function (error) {
      console.warn("Firebase 삭제 기록 실시간 연결을 유지하지 못했습니다.", error);
    });
  }

  function scheduleSplitCloudSync(cloudState) {
    var signature = splitCloudSignature(cloudState);
    if (signature === splitCloudLastSignature) return;
    splitCloudSavePending = cloudState;
    if (splitCloudSaveTimer) clearTimeout(splitCloudSaveTimer);
    splitCloudSaveTimer = setTimeout(function () {
      var pending = splitCloudSavePending;
      splitCloudSavePending = null;
      splitCloudSaveTimer = null;
      syncSplitCloudState(pending).then(function () {
        splitCloudLastSignature = splitCloudSignature(pending);
      }).catch(function (error) {
        console.warn("Firebase 관리 컬렉션을 정리하지 못했습니다.", error);
      });
    }, 2200);
  }

  function flushQuickCloudState() {
    if (quickCloudSaveInFlight || !quickCloudSavePending) return Promise.resolve(true);
    var docRef = firebaseDocument();
    if (!docRef) return Promise.resolve(false);
    var cloudState = quickCloudSavePending;
    var now = num(cloudState.clientUpdatedAt) || Date.now();
    quickCloudSavePending = null;
    quickCloudSaveInFlight = true;
    notifyCloudStatus("saving");
    return docRef.set({ state: cloudState, clientUpdatedAt: now, dataVersion: DATA_VERSION }, { merge: false }).then(function () {
      notifyCloudStatus("synced");
      return true;
    }).catch(function (error) {
      console.warn("Firebase 데이터를 저장하지 못했습니다.", error);
      notifyCloudStatus("error");
      return false;
    }).then(function (result) {
      quickCloudSaveInFlight = false;
      if (quickCloudSavePending) flushQuickCloudState();
      return result;
    });
  }

  function pushCloudState(state) {
    if (!firebaseDatabase()) return Promise.resolve(false);
    var now = Date.now();
    quickCloudSavePending = Object.assign({}, clone(state), {
      clientUpdatedAt: now,
      sales: (state.sales || []).slice(0, MAX_SALES)
    });
    return flushQuickCloudState();
  }

  function subscribeCloudState(onState) {
    var docRef = firebaseDocument();
    if (!docRef || typeof docRef.onSnapshot !== "function") return function () {};
    return docRef.onSnapshot(function (snapshot) {
      if (!snapshot.exists) return;
      var data = snapshot.data() || {};
      notifyCloudStatus("synced");
      if (data.state) onState(data.state);
    }, function (error) {
      console.warn("Firebase 실시간 연결을 유지하지 못했습니다.", error);
      notifyCloudStatus("error");
    });
  }

  function subscribeSalesCollection(onSales) {
    var collection = firebaseCollection("sales");
    if (!collection || typeof collection.onSnapshot !== "function") return function () {};
    return collection.orderBy("createdAt", "desc").limit(MAX_SALES).onSnapshot(function (snapshot) {
      var sales = docsToRows(snapshot).map(cleanRemoteRow).sort(function (a, b) {
        return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "");
      }).slice(0, MAX_SALES);
      notifyCloudStatus("synced");
      onSales(sales);
    }, function (error) {
      console.warn("Firebase 판매 내역 실시간 연결을 유지하지 못했습니다.", error);
      notifyCloudStatus("error");
    });
  }

  function subscribeManagementCollections(onRows) {
    var configs = [
      { key: "categories", collection: "categories" },
      { key: "groups", collection: "subcategories" },
      { key: "items", collection: "items" },
      { key: "customers", collection: "customers" },
      { key: "writers", collection: "writers" }
    ];
    var unsubs = configs.map(function (config) {
      var collection = firebaseCollection(config.collection);
      if (!collection || typeof collection.onSnapshot !== "function") return function () {};
      return collection.onSnapshot(function (snapshot) {
        var docs = docsToRows(snapshot);
        var latestCloudUpdate = docs.reduce(function (latest, row) { return Math.max(latest, num(row.cloudUpdatedAt)); }, 0);
        var rows = sortRows(docs.map(cleanRemoteRow));
        notifyCloudStatus("synced");
        onRows(config.key, rows, latestCloudUpdate);
      }, function (error) {
        console.warn("Firebase 관리 컬렉션 실시간 연결을 유지하지 못했습니다.", config.key, error);
        notifyCloudStatus("error");
      });
    });
    return function () {
      unsubs.forEach(function (unsubscribe) {
        try { unsubscribe(); } catch (error) {}
      });
    };
  }

  function readAuth() {
    localStorage.removeItem(AUTH_KEY);
    return false;
  }

  function readSettlementAuth() {
    return false;
  }

  function writeAuth(settlement) {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem("piercing-pos-authorized");
  }

  function loginLocked() {
    try {
      var lock = JSON.parse(localStorage.getItem(LOGIN_LOCK_KEY) || "null");
      if (!lock) return false;
      return lock.until && Date.now() < lock.until;
    } catch (error) {
      localStorage.removeItem(LOGIN_LOCK_KEY);
      return false;
    }
  }

  function recordLoginFailure() {
    var lock = {};
    try {
      lock = JSON.parse(localStorage.getItem(LOGIN_LOCK_KEY) || "{}");
    } catch (error) {
      lock = {};
    }
    var attempts = (lock.attempts || 0) + 1;
    localStorage.setItem(LOGIN_LOCK_KEY, JSON.stringify({
      attempts: attempts,
      until: attempts >= 5 ? Date.now() + 5 * 60 * 1000 : 0
    }));
  }

  function id(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  var seed = {
    store: { id: "store_demo", name: "피어싱 계산", adminKey: "0000" },
    categories: [
      { id: "cat_earring", name: "피어싱", sort: 1, discountableDefault: true, active: true },
      { id: "cat_silver", name: "실버", sort: 2, discountableDefault: true, active: true },
      { id: "cat_other", name: "기타", sort: 3, discountableDefault: true, active: true },
      { id: "cat_surgical", name: "써지컬", sort: 4, discountableDefault: true, active: true },
      { id: "cat_clay", name: "점토", sort: 5, discountableDefault: true, active: true },
      { id: "cat_parts", name: "부자제", sort: 6, discountableDefault: true, active: true },
      { id: "cat_no_discount", name: "할인 X", sort: 7, discountableDefault: false, active: true }
    ],
    items: [
      { id: "item_earring_1000", categoryId: "cat_earring", name: "귀걸이", price: 1000, discountable: true, active: true },
      { id: "item_earring_2000_a", categoryId: "cat_earring", name: "귀걸이 A", price: 2000, discountable: true, active: true },
      { id: "item_earring_2000_b", categoryId: "cat_earring", name: "귀걸이 B", price: 2000, discountable: true, active: true },
      { id: "item_earring_2000_c", categoryId: "cat_earring", name: "귀걸이 C", price: 2000, discountable: true, active: true },
      { id: "item_earring_3000", categoryId: "cat_earring", name: "귀걸이", price: 3000, discountable: true, active: true },
      { id: "item_silver_3000", categoryId: "cat_silver", name: "실버", price: 3000, discountable: true, active: true },
      { id: "item_silver_5000", categoryId: "cat_silver", name: "실버", price: 5000, discountable: true, active: true },
      { id: "item_pearl_1000", categoryId: "cat_other", groupName: "진주", name: "진주", price: 1000, discountable: true, active: true },
      { id: "item_pearl_200", categoryId: "cat_other", groupName: "진주", name: "진주", price: 200, discountable: true, active: true },
      { id: "item_coating_1000", categoryId: "cat_other", groupName: "코팅", name: "코팅", price: 1000, discountable: true, active: true },
      { id: "item_coating_200", categoryId: "cat_other", groupName: "코팅", name: "코팅", price: 200, discountable: true, active: true },
      { id: "item_parts_500", categoryId: "cat_parts", name: "부자재", price: 500, discountable: true, active: true },
      { id: "item_parts_1000", categoryId: "cat_parts", name: "부자재", price: 1000, discountable: true, active: true },
      { id: "item_fixed_1000", categoryId: "cat_no_discount", name: "할인 제외", price: 1000, discountable: false, active: true },
      { id: "item_fixed_2000", categoryId: "cat_no_discount", name: "할인 제외", price: 2000, discountable: false, active: true }
    ],
    customers: [
      { id: "customer_walkin", name: "일반", discountRate: 0, vatEnabled: false, active: true, note: "", pricingRules: [], discountRules: [] },
      { id: "customer_shop", name: "거래처", discountRate: 10, vatEnabled: false, active: true, note: "", pricingRules: [], discountRules: [] }
    ],
    writers: [
      { id: "writer_default", name: "미정", active: true },
      { id: "writer_kimeunkyeong", name: "김은경", active: true },
      { id: "writer_kimyejin", name: "김예진", active: true },
      { id: "writer_kimdonggyu", name: "김동규", active: true },
      { id: "writer_goeunkyeong", name: "고은경", active: true }
    ],
    groups: [],
    sales: []
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function catalogItem(itemId, categoryId, name, price, groupName) {
    return { id: itemId, categoryId: categoryId, groupName: groupName || "", name: name, price: price, discountable: categoryId !== "cat_no_discount", active: true };
  }

  function catalogItems(prefix, categoryId, groupName, entries) {
    return entries.map(function (entry, index) {
      return catalogItem(prefix + "_" + index, categoryId, entry[0], entry[1], groupName);
    });
  }

  var customerDefaultsText = [
    "개코(거북이,양마) - 10%",
    "꾸밈 - 10%",
    "끼(성신여대) - 10%",
    "나림 - 5%",
    "남양주 - 15%",
    "노랑누리 - 15%",
    "노원 홀릭 - 10%",
    "천호 썸 - 10%",
    "더플레인(의정부,영등포) - 15%",
    "더플레인(그외) - 10%",
    "댕글링 - 15%",
    "도도(강남) - 10%",
    "동해(핑크핑크해) - 10%",
    "뜨루 - 15%",
    "럽앤미니 - 15%",
    "레드캣츠(마산, 창원) - 5%",
    "레인보우(광주) - 15%",
    "망고(전주) - 10%",
    "멋쟁이 - 10%",
    "모모(대구,창원) - 10%",
    "모엘로(제이에스리테일) - 20%",
    "무드모아젤 - 5%",
    "미녀와야수(부평) - 10%",
    "벽작 - 10%",
    "베이커리 - 15%",
    "보나(청주, 대전) - 10%",
    "블링박스(명동, 중앙, 월드) - 15%",
    "블링블링(안산) - 5%",
    "뺑끼통 - 15%",
    "사월피어싱 - 5%",
    "샵원(부평) - 10%",
    "스텔라(홍대) - 15%",
    "스카이 - 5%",
    "실버비키니(덕천티아라) - 5%",
    "심미안(건대) - 0%",
    "심미안(건대 제외) - 15%",
    "일산 심쿵 - 15%",
    "노원 심쿵 - 15%",
    "아이피엠(IPM) - 5%",
    "아이엠엠제이(IAMJ) - 15%",
    "에이에스에프(ASAP) - 10%",
    "달콤한피어씽 - 10%",
    "도노(전주) - 10%",
    "비비 - 5%",
    "Stan1983 - 5%",
    "쇼콜라(제주) - 5%",
    "스파이시 - 0% 무역회사 5%",
    "스파이시(현금) - 0%",
    "잠실 심쿵 - 5%",
    "에브리띵 2900 - 20%",
    "웬디(홍콩) - 10%",
    "악동클럽 - 5%",
    "안녕피어싱 - 15%",
    "에이미(대전) - 15%",
    "에이미(청주) - 10%",
    "에이치 H스토리(부산) - 10%",
    "에크미 - 5%",
    "엔피어싱(대구) - 10%",
    "오르가미 - 15%",
    "오링 - 10%",
    "우현로 - 10%",
    "유어유즈 - 5%",
    "원피어싱(홍대,부평) - 20% (니들 10,000원)",
    "왕워이치 - 10%",
    "엔젤(화정) - 10%",
    "인디오(상동) - 5%",
    "이쁜것들(남,여,동생,심쿵) - 15%",
    "작은밀라노(미니스) - 20%",
    "장신구(일쩜오) - 10%",
    "제이주얼 - 10%",
    "제트피어싱 - 15%",
    "찌(홍대) - 20%",
    "조아 - 20%",
    "쥬얼트리 - 10%",
    "짱(천안) - 10%",
    "초이스(동대문) - 10%",
    "카라(광주,천안) - 15% 점토 할인X",
    "카라(부산) - 5%",
    "카와이 - 5%",
    "카마 - 10%",
    "코브라(홍대,천안) - 5%",
    "큐다호 - 0% 무역회사 5%",
    "큐다호(현금) - 0%",
    "킹스버드(안양) - 10%",
    "크로우(인천) - 10%",
    "크로우(일산) - 15%",
    "크로우(의정부) - 5%",
    "크로우(그외) - 5%",
    "트윙클(영등포) - 15%",
    "팝콘(대구) - 10%",
    "포인트(전주) - 5%",
    "핑크트리 - 5%",
    "히가시노 - 0% 무역회사 5%",
    "히가시노(현금) - 0%",
    "암마 - 15%",
    "at3 - 5%",
    "아라다움 - 20%",
    "이어빛 - 10%",
    "핑크(안양) - 10%",
    "AA랜드 - 10%",
    "fei(대만) - 10%",
    "피어싱프로 - 15%",
    "만원샵 - 0%",
    "만원샵(바벨만) - 5%",
    "티아라(덕천) - 5%",
    "블링블링(인천) - 0%",
    "블링블링(인천실버) - 15%",
    "삔(충주) - 5% (볼챙겨 드리기)"
  ];

  function stableCustomerId(name) {
    var text = safeText(name).toLowerCase();
    var hash = 0;
    for (var index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return "customer_" + Math.abs(hash).toString(36);
  }

  function customerRulesFromNote(note) {
    var cleanNote = safeText(note);
    var pricingRules = [];
    var discountRules = [];
    if (/니들\s*10,?000원/.test(cleanNote)) {
      pricingRules.push({ type: "itemPrice", match: "니들", price: 10000, label: "니들 10,000원" });
    }
    if (/점토\s*할인\s*x/i.test(cleanNote)) {
      discountRules.push({ type: "excludeCategory", categoryId: "cat_clay", label: "점토 할인X" });
    }
    var tradeMatch = cleanNote.match(/무역회사\s*(\d+(?:\.\d+)?)%/);
    var tradeCommissionRate = tradeMatch ? clamp(tradeMatch[1], 0, 100) : /무역회사/.test(cleanNote) ? 5 : 0;
    return { pricingRules: pricingRules, discountRules: discountRules, vatExempt: /무역회사/.test(cleanNote), offshore: /무역회사/.test(cleanNote), tradeCompanyName: "MBN", tradeCommissionRate: tradeCommissionRate };
  }

  function normalizeCustomer(customer) {
    var note = safeText(customer && customer.note || "");
    var rules = customerRulesFromNote(note);
    return Object.assign({}, customer, {
      id: customer && customer.id ? customer.id : stableCustomerId(customer && customer.name),
      name: safeText(customer && customer.name),
      discountRate: clamp(customer && customer.discountRate, 0, 100),
      vatEnabled: !!(customer && customer.vatEnabled),
      active: customer && customer.active === false ? false : true,
      note: note,
      pricingRules: Array.isArray(customer && customer.pricingRules) && customer.pricingRules.length ? customer.pricingRules : rules.pricingRules,
      discountRules: Array.isArray(customer && customer.discountRules) && customer.discountRules.length ? customer.discountRules : rules.discountRules,
      vatExempt: !!(customer && customer.vatExempt) || rules.vatExempt,
      offshore: !!(customer && customer.offshore) || rules.offshore,
      tradeCompanyName: safeText(customer && customer.tradeCompanyName || rules.tradeCompanyName || ""),
      tradeCommissionRate: clamp(customer && customer.tradeCommissionRate != null ? customer.tradeCommissionRate : rules.tradeCommissionRate, 0, 100)
    });
  }

  function parseCustomerDefaults() {
    return customerDefaultsText.map(function (line) {
      var match = line.match(/^(.+?)\s*-\s*(\d+(?:\.\d+)?)%\s*(.*)$/);
      if (!match) return null;
      var note = safeText(match[3] || "").replace(/^\((.*)\)$/, "$1");
      var rules = customerRulesFromNote(note);
      return {
        id: stableCustomerId(match[1]),
        name: safeText(match[1]),
        discountRate: clamp(match[2], 0, 100),
        vatEnabled: false,
        active: true,
        note: note,
        pricingRules: rules.pricingRules,
        discountRules: rules.discountRules,
        vatExempt: rules.vatExempt,
        offshore: rules.offshore,
        tradeCompanyName: rules.tradeCompanyName,
        tradeCommissionRate: rules.tradeCommissionRate
      };
    }).filter(Boolean);
  }

  var customerMergeAliases = {
    "히가시노(무역회사)": "히가시노",
    "큐다호(무역회사)": "큐다호",
    "스파이시(무역회사)": "스파이시"
  };

  var removedCustomerNames = {
    "노원(홀릭) 썸(천호)": true,
    "노원(홀릭)썸(천호)": true,
    "심콩(일산,노원)": true,
    "심쿵(일산,노원)": true,
    "심쿵( 일산,노원)": true,
    "심쿰잠실": true,
    "잠실심쿰": true
  };

  function reconcileCustomerRenames(customers) {
    var next = [];
    var indexByName = {};
    function addOrUpdate(customer) {
      var cleanName = safeText(customer && customer.name);
      if (!cleanName || removedCustomerNames[cleanName]) return;
      var normalized = normalizeCustomer(Object.assign({}, customer, { name: cleanName }));
      var existingIndex = indexByName[normalized.name];
      if (existingIndex == null) {
        indexByName[normalized.name] = next.length;
        next.push(normalized);
        return;
      }
      next[existingIndex] = Object.assign({}, next[existingIndex], normalized);
    }
    (customers || []).forEach(addOrUpdate);
    [
      { name: "노원 홀릭", discountRate: 10 },
      { name: "천호 썸", discountRate: 10 },
      { name: "일산 심쿵", discountRate: 15 },
      { name: "노원 심쿵", discountRate: 15 },
      { name: "잠실 심쿵", discountRate: 5 }
    ].forEach(function (entry) {
      addOrUpdate({
        id: stableCustomerId(entry.name),
        name: entry.name,
        discountRate: entry.discountRate,
        vatEnabled: false,
        active: true,
        note: "",
        pricingRules: [],
        discountRules: []
      });
    });
    return next;
  }

  function mergeCustomerAliases(customers) {
    var merged = [];
    var indexByName = {};
    customers.forEach(function (customer) {
      var targetName = customerMergeAliases[customer.name] || customer.name;
      if (targetName !== customer.name && indexByName[targetName] == null) return;
      var existingIndex = indexByName[targetName];
      if (existingIndex == null) {
        indexByName[targetName] = merged.length;
        merged.push(Object.assign({}, customer, { name: targetName, id: targetName === customer.name ? customer.id : stableCustomerId(targetName) }));
        return;
      }
      var existing = merged[existingIndex];
      merged[existingIndex] = Object.assign({}, existing, {
        note: customerRuleSummary(existing) || existing.note || customer.note || "",
        active: existing.active !== false || customer.active !== false
      });
    });
    return merged;
  }

  var catalogDefaults = [
    catalogItem("item_p_1000", "cat_earring", "P", 1000),
    catalogItem("item_p_1200", "cat_earring", "P", 1200),
    catalogItem("item_p_1300", "cat_earring", "P", 1300),
    catalogItem("item_p_1400", "cat_earring", "P", 1400),
    catalogItem("item_p_1500", "cat_earring", "P", 1500),
    catalogItem("item_p_1600", "cat_earring", "P", 1600),
    catalogItem("item_p_1800", "cat_earring", "P", 1800),
    catalogItem("item_p_2000", "cat_earring", "P", 2000),
    catalogItem("item_p_2200", "cat_earring", "P", 2200),
    catalogItem("item_p_2400", "cat_earring", "P", 2400),
    catalogItem("item_p_2500", "cat_earring", "P", 2500),
    catalogItem("item_p_2800", "cat_earring", "P", 2800),
    catalogItem("item_p_3000", "cat_earring", "P", 3000),
    catalogItem("item_ps_3000", "cat_earring", "PS", 3000),
    catalogItem("item_p_3200", "cat_earring", "P", 3200),
    catalogItem("item_p_3500", "cat_earring", "P", 3500),
    catalogItem("item_p_4000", "cat_earring", "P", 4000),
    catalogItem("item_sp_3000", "cat_silver", "S.P", 3000),
    catalogItem("item_sp_3200", "cat_silver", "S.P", 3200),
    catalogItem("item_sp_3500", "cat_silver", "S.P", 3500),
    catalogItem("item_sp_3800", "cat_silver", "S.P", 3800),
    catalogItem("item_sp_4000", "cat_silver", "S.P", 4000),
    catalogItem("item_sp_4200", "cat_silver", "S.P", 4200),
    catalogItem("item_sp_4500", "cat_silver", "S.P", 4500),
    catalogItem("item_sp_4800", "cat_silver", "S.P", 4800),
    catalogItem("item_sp_5000", "cat_silver", "S.P", 5000),
    catalogItem("item_sp_5200", "cat_silver", "S.P", 5200),
    catalogItem("item_sp_5500", "cat_silver", "S.P", 5500),
    catalogItem("item_sp_5800", "cat_silver", "S.P", 5800),
    catalogItem("item_sp_6000", "cat_silver", "S.P", 6000),
    catalogItem("item_sp_6200", "cat_silver", "S.P", 6200),
    catalogItem("item_sp_6500", "cat_silver", "S.P", 6500),
    catalogItem("item_sp_6800", "cat_silver", "S.P", 6800),
    catalogItem("item_stone_round45", "cat_other", "원 4.5", 500, "스톤ㆍ큐빅"),
    catalogItem("item_stone_star_heart_flower", "cat_other", "별ㆍ하트ㆍ꽃", 1000, "스톤ㆍ큐빅"),
    catalogItem("item_stone_ball_hex", "cat_other", "구ㆍ육각", 1300, "스톤ㆍ큐빅"),
    catalogItem("item_stone_claw", "cat_other", "물림", 800, "스톤ㆍ큐빅"),
    catalogItem("item_stone_woolim_p", "cat_other", "물림P", 1200, "스톤ㆍ큐빅"),
    catalogItem("item_pearl_both", "cat_other", "양쪽", 500, "진주"),
    catalogItem("item_pearl_one6", "cat_other", "한쪽6", 700, "진주"),
    catalogItem("item_pearl_one8", "cat_other", "한쪽8", 1200, "진주"),
    catalogItem("item_acrylic_t_heart", "cat_other", "하트", 500, "아크릴T바"),
    catalogItem("item_acrylic_t_acrylic", "cat_other", "아크릴", 600, "아크릴T바"),
    catalogItem("item_acrylic_t_rose", "cat_other", "장미", 800, "아크릴T바"),
    catalogItem("item_acrylic_t_butterfly", "cat_other", "나비", 1000, "아크릴T바"),
    catalogItem("item_other_laser_cutting", "cat_other", "레이져컷팅", 1800, "기타"),
    catalogItem("item_other_two_ball_ring", "cat_other", "투볼링", 500, "기타")
  ].concat(
    catalogItems("item_surgical_barbell", "cat_surgical", "바벨", [["3ㆍ4", 300], ["2ㆍ5", 400], ["G", 900], ["P", 1100], ["B", 700]]),
    catalogItems("item_surgical_segment", "cat_surgical", "세크먼트링", [["기본", 1600], ["GㆍB", 1800], ["P", 2000], ["오팔", 5500], ["파츠", 2200]]),
    catalogItems("item_surgical_internal", "cat_surgical", "인터널", [["잼ㆍ평", 1200], ["라운드", 1300], ["별", 1600], ["사각", 1600]]),
    catalogItems("item_surgical_fake", "cat_surgical", "훼이크", [["민A", 600], ["민B", 800], ["에폭ㆍ단추S", 1300], ["에폭ㆍ단추SG", 1600], ["에폭ㆍ단추L", 1600], ["에폭ㆍ단추LG", 1800], ["스톤6ㆍ8", 1300], ["스톤10", 1600], ["스톤6ㆍ8BG", 1600], ["스톤10BG", 1800]]),
    catalogItems("item_clay_basic", "cat_clay", "일반 점토", [["3", 800], ["4", 1000], ["5", 1200], ["6", 1300], ["8", 2000]]),
    catalogItems("item_clay_coated", "cat_clay", "코팅 점토", [["3", 900], ["4", 1100], ["5", 1300], ["6", 1400], ["믹스", 1400]]),
    catalogItems("item_parts_new", "cat_parts", "", [["바~12", 1800], ["바~22", 2200], ["바 28~", 6000], ["라블렛", 2500], ["바나나", 2500], ["투볼링", 5000], ["T자", 15000], ["니들 100개", 15000], ["탭볼3ㆍ4", 3000], ["탭볼5", 4000], ["티탄볼", 5000], ["인터널", 6000], ["평스톤", 2500], ["잼스톤", 2500], ["큐빅~3", 5000], ["큐빅4~", 6000], ["사각", 7000], ["별", 7000], ["탭볼", 12000], ["귀걸이", 25000], ["크러치", 1500]]),
    catalogItems("item_no_discount_new", "cat_no_discount", "", [["스톤 2ㆍ3", 300], ["바 1,000개", 25000], ["볼 1,000개", 40000], ["은볼10개", 10000], ["큐빅링5ㆍ6", 3000], ["큐빅링8~", 4000], ["할인", 300], ["할인", 500], ["할인", 1000], ["배송", 3500], ["배송(양양)", 1000]])
  ).map(function (item, index) {
    return Object.assign({}, item, { sort: index + 1 });
  });

  function isBuiltInCatalogItem(item) {
    var itemId = String(item && item.id || "");
    return /^item_(earring|silver|pearl|coating|parts|fixed)_/.test(itemId) ||
      /^item_(p|sp|stone|acrylic|other|surgical|clay|parts_new|no_discount_new)_/.test(itemId);
  }

  function normalizeState(state) {
    var categoryOverrides = {
      cat_earring: { name: "피어싱", sort: 1, discountableDefault: true, active: true },
      cat_silver: { name: "실버", sort: 2, discountableDefault: true, active: true },
      cat_other: { name: "기타", sort: 3, discountableDefault: true, active: true },
      cat_surgical: { name: "써지컬", sort: 4, discountableDefault: true, active: true },
      cat_clay: { name: "점토", sort: 5, discountableDefault: true, active: true },
      cat_parts: { name: "부자제", sort: 6, discountableDefault: true, active: true },
      cat_no_discount: { name: "할인 X", sort: 7, discountableDefault: false, active: true }
    };
    var shouldUpgrade = state.dataVersion !== DATA_VERSION;
    var categories = Array.isArray(state.categories) ? state.categories.slice() : clone(seed.categories);
    Object.keys(categoryOverrides).forEach(function (categoryId) {
      var index = categories.findIndex(function (category) { return category.id === categoryId; });
      if (index >= 0) {
        categories[index] = Object.assign({}, categories[index], categoryOverrides[categoryId], { sort: shouldUpgrade || categories[index].sort == null ? categoryOverrides[categoryId].sort : categories[index].sort });
      } else {
        categories.push(Object.assign({ id: categoryId }, categoryOverrides[categoryId]));
      }
    });
    var items = Array.isArray(state.items) ? state.items.map(function (item) {
      if (item.categoryId === "cat_earring") return Object.assign({}, item, { name: "P", groupName: "" });
      if (item.categoryId === "cat_silver") return Object.assign({}, item, { name: "S.P", groupName: "" });
      if (item.categoryId === "cat_other" && item.groupName === "스톤ㆍ큐빅" && item.name === "울림P") return Object.assign({}, item, { name: "물림P" });
      if (item.categoryId === "cat_surgical" && item.groupName === "세그먼트링") return Object.assign({}, item, { groupName: "세크먼트링" });
      if (item.categoryId === "cat_no_discount" && item.name === "할인 300" || item.categoryId === "cat_no_discount" && item.name === "할인 500" || item.categoryId === "cat_no_discount" && item.name === "할인 1000") return Object.assign({}, item, { name: "할인" });
      if (item.categoryId === "cat_no_discount" && item.name === "은볼10") return Object.assign({}, item, { name: "은볼10개" });
      if (item.categoryId === "cat_no_discount" && item.name === "바1,000") return Object.assign({}, item, { name: "바 1,000개" });
      if (item.categoryId === "cat_no_discount" && item.name === "볼1,000") return Object.assign({}, item, { name: "볼 1,000개" });
      return item;
    }) : [];
    var writers = Array.isArray(state.writers) ? state.writers.slice() : [];
    if (!writers.length || shouldUpgrade) writers = clone(seed.writers);
    if (!writers.some(function (writer) { return writer.id === "writer_default"; })) {
      writers.unshift(clone(seed.writers[0]));
    }
    writers = writers.map(function (writer) {
      return writer.id === "writer_default" ? Object.assign({}, writer, { name: "미정" }) : writer;
    });
    if (shouldUpgrade) {
      items = items.filter(function (item) { return !isBuiltInCatalogItem(item); });
      catalogDefaults.forEach(function (defaultItem) {
        items.push(clone(defaultItem));
      });
    }
    var defaultItemIds = {};
    catalogDefaults.forEach(function (item) { defaultItemIds[item.id] = true; });
    var compactItems = [];
    var compactItemIndex = {};
    items.forEach(function (item) {
      var compactKey = item.categoryId === "cat_earring" || item.categoryId === "cat_silver"
        ? [item.categoryId, safeText(item.groupName), safeText(item.name), num(item.price)].join("|")
        : String(item.id);
      var previousIndex = compactItemIndex[compactKey];
      if (previousIndex == null) {
        compactItemIndex[compactKey] = compactItems.length;
        compactItems.push(item);
        return;
      }
      if (defaultItemIds[item.id] && !defaultItemIds[compactItems[previousIndex].id]) compactItems[previousIndex] = item;
    });
    items = compactItems;
    var customers = Array.isArray(state.customers) ? state.customers.map(normalizeCustomer).filter(function (customer) { return customer.name; }) : clone(seed.customers).map(normalizeCustomer);
    customers = mergeCustomerAliases(customers);
    customers = reconcileCustomerRenames(customers);
    var customerNameIndex = {};
    customers.forEach(function (customer, index) {
      customerNameIndex[customer.name] = index;
    });
    if (shouldUpgrade) {
      parseCustomerDefaults().forEach(function (defaultCustomer) {
        var index = customerNameIndex[defaultCustomer.name];
        if (index == null) {
          customerNameIndex[defaultCustomer.name] = customers.length;
          customers.push(defaultCustomer);
        } else if (customers[index].id !== "customer_walkin") {
          customers[index] = Object.assign({}, customers[index], {
            discountRate: defaultCustomer.discountRate,
            note: defaultCustomer.note,
            pricingRules: defaultCustomer.pricingRules,
            discountRules: defaultCustomer.discountRules,
            vatExempt: defaultCustomer.vatExempt,
            offshore: defaultCustomer.offshore,
            tradeCompanyName: defaultCustomer.tradeCompanyName,
            tradeCommissionRate: defaultCustomer.tradeCommissionRate,
            active: customers[index].active === false ? false : true
          });
        }
      });
    }
    var groups = Array.isArray(state.groups) ? state.groups.slice() : [];
    items.forEach(function (item) {
      var groupName = safeText(item.groupName || "");
      if (!groupName) return;
      var exists = groups.some(function (group) { return group.categoryId === item.categoryId && group.name === groupName; });
      if (!exists) {
        groups.push({ id: id("group"), categoryId: item.categoryId, name: groupName, sort: item.sort || Date.now(), active: true });
      }
    });
    return Object.assign({}, state, { categories: categories, items: items, customers: customers, writers: writers, groups: groups, dataVersion: DATA_VERSION });
  }

  function loadState() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (!saved) {
        var freshState = normalizeState(clone(seed));
        saveState(freshState);
        return freshState;
      }
      var parsed = JSON.parse(saved);
      return normalizeState(Object.assign(clone(seed), parsed, {
        categories: Array.isArray(parsed.categories) ? parsed.categories : seed.categories,
        items: Array.isArray(parsed.items) ? parsed.items : seed.items,
        customers: Array.isArray(parsed.customers) ? parsed.customers : seed.customers,
        writers: Array.isArray(parsed.writers) ? parsed.writers : seed.writers,
        groups: Array.isArray(parsed.groups) ? parsed.groups : seed.groups,
        sales: Array.isArray(parsed.sales) ? parsed.sales.slice(0, MAX_SALES) : []
      }));
    } catch (error) {
      localStorage.removeItem(STORE_KEY);
      var resetState = normalizeState(clone(seed));
      saveState(resetState);
      return resetState;
    }
  }

  function lineMatchesRule(line, rule) {
    if (!line || !rule) return false;
    var match = safeText(rule.match || "");
    if (match && safeText(line.name).indexOf(match) >= 0) return true;
    if (rule.categoryId && line.categoryId === rule.categoryId) return true;
    return false;
  }

  function customerPriceForItem(item, customer) {
    var rules = customer && Array.isArray(customer.pricingRules) ? customer.pricingRules : [];
    for (var index = 0; index < rules.length; index += 1) {
      var rule = rules[index];
      if (!rule || rule.type !== "itemPrice") continue;
      if (lineMatchesRule({ name: item.name, categoryId: item.categoryId, groupName: item.groupName }, rule)) return clamp(rule.price, 0, MAX_PRICE);
    }
    return null;
  }

  function isCustomerDiscountExcluded(line, customer) {
    var rules = customer && Array.isArray(customer.discountRules) ? customer.discountRules : [];
    return rules.some(function (rule) {
      if (!rule || rule.type !== "excludeCategory") return false;
      if (rule.categoryId && line.categoryId === rule.categoryId) return true;
      return rule.categoryId === "cat_clay" && (safeText(line.name).indexOf("점토") >= 0 || safeText(line.groupName).indexOf("점토") >= 0);
    });
  }

  function customerRuleSummary(customer) {
    var parts = [];
    if (customer && customer.note) parts.push(customer.note);
    (customer && customer.pricingRules || []).forEach(function (rule) {
      if (rule && rule.label && parts.indexOf(rule.label) < 0) parts.push(rule.label);
    });
    (customer && customer.discountRules || []).forEach(function (rule) {
      if (rule && rule.label && parts.indexOf(rule.label) < 0) parts.push(rule.label);
    });
    return parts.join(" · ");
  }

  function isVatExemptCustomer(customer) {
    return !!(customer && customer.vatExempt && !customer.offshore);
  }

  function offshoreSettlementForTotal(total, customer) {
    if (!customer || !customer.offshore) return null;
    var shippingFee = num(total && total.shippingFee);
    var japanAmount = Math.max(0, num(total && total.total) - shippingFee);
    var commissionRate = clamp(customer.tradeCommissionRate || 5, 0, 100);
    var supply = Math.round(japanAmount * (1 - commissionRate / 100));
    var vat = Math.round(supply * 0.1);
    var receivable = supply + vat;
    var commission = Math.max(0, japanAmount - supply);
    return {
      tradeCompanyName: customer.tradeCompanyName || "MBN",
      commissionRate: commissionRate,
      japanAmount: japanAmount,
      commission: commission,
      receivable: receivable,
      supply: supply,
      vat: vat,
      shippingFee: shippingFee
    };
  }

  function totals(cart, customer) {
    function lineIsDiscountable(line) {
      return line && line.categoryId !== "cat_no_discount" && line.discountable !== false;
    }
    function lineIsShipping(line) {
      return line && (line.name === "배송" || line.name === "배송(양양)");
    }
    var customerRate = Math.max(0, num(customer && customer.discountRate)) / 100;
    var hasExclusiveCustomerDiscount = customerRate > 0 || !!(customer && customer.offshore);
    var subtotal = cart.reduce(function (sum, line) {
      var basePrice = line.originalPrice != null ? line.originalPrice : line.price;
      return sum + basePrice * line.quantity;
    }, 0);
    var thresholdEligibleSubtotal = cart.reduce(function (sum, line) {
      var basePrice = line.originalPrice != null ? line.originalPrice : line.price;
      var directDiscount = Math.max(0, basePrice - line.price) * line.quantity;
      if (directDiscount > 0 || lineIsShipping(line)) return sum;
      return sum + basePrice * line.quantity;
    }, 0);
    var thresholdRate = hasExclusiveCustomerDiscount ? 0 : thresholdEligibleSubtotal >= 1000000 ? 0.1 : thresholdEligibleSubtotal >= 500000 ? 0.05 : 0;
    var thresholdDiscount = Math.round(thresholdEligibleSubtotal * thresholdRate);
    var discount = cart.reduce(function (sum, line) {
      var basePrice = line.originalPrice != null ? line.originalPrice : line.price;
      var directDiscount = hasExclusiveCustomerDiscount ? 0 : Math.max(0, basePrice - line.price) * line.quantity;
      if (!lineIsDiscountable(line)) return sum + directDiscount;
      var lineCustomerRate = isCustomerDiscountExcluded(line, customer) ? 0 : customerRate;
      return sum + directDiscount + Math.round(basePrice * line.quantity * lineCustomerRate);
    }, 0) + thresholdDiscount;
    var supply = subtotal - discount;
    var vat = customer && customer.vatEnabled && !customer.offshore && !isVatExemptCustomer(customer) ? Math.round(supply * 0.1) : 0;
    return { subtotal: subtotal, discount: discount, supply: supply, vat: vat, total: supply + vat };
  }

  function itemDiscountable(categoryId, categories) {
    var category = categories.find(function (entry) { return entry.id === categoryId; });
    return category ? category.discountableDefault !== false : true;
  }

  function catalogDiscountApplies(item, enabled) {
    if (!enabled || !item) return false;
    if (item.categoryId === "cat_earring" && num(item.price) <= 1000) return false;
    return item.categoryId === "cat_earring" || item.categoryId === "cat_silver";
  }

  function salesSummaryForDate(sales, targetDate) {
    var start = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    var end = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
    return (sales || []).reduce(function (summary, sale) {
      var createdAt = new Date(sale.createdAt);
      if (Number.isNaN(createdAt.getTime()) || createdAt < start || createdAt > end) return summary;
      var lines = sale.lines || [];
      var totalsValue = sale.totals || {};
      summary.count += 1;
      summary.quantity += lines.reduce(function (sum, line) { return sum + num(line.quantity); }, 0);
      summary.subtotal += num(totalsValue.subtotal);
      summary.discount += num(totalsValue.discount);
      summary.vat += num(totalsValue.vat);
      summary.total += num(totalsValue.total);
      return summary;
    }, { count: 0, quantity: 0, subtotal: 0, discount: 0, vat: 0, total: 0 });
  }

  function isOtherCategory(category) {
    return !!category && (category.id === "cat_other" || category.name === "기타");
  }

  function getOtherCategoryId(categories) {
    var category = categories.find(isOtherCategory);
    return category ? category.id : "";
  }

  function Icon(props) {
    return h("span", { "aria-hidden": true }, props.name === "print" ? "▣" : props.name === "trash" ? "×" : props.name === "minus" ? "-" : "+");
  }

  function App() {
    var stateHook = React.useState(loadState());
    var state = stateHook[0], rawSetState = stateHook[1];
    function setState(update) {
      rawSetState(function (current) {
        var next = typeof update === "function" ? update(current) : update;
        if (!next || next === current) return current;
        var stamped = Object.assign({}, next, { clientUpdatedAt: Date.now() });
        syncManagementDiff(current, stamped);
        return stamped;
      });
    }
    var authHook = React.useState(readAuth());
    var authorized = authHook[0], setAuthorized = authHook[1];
    var settlementHook = React.useState(readSettlementAuth());
    var settlementAccess = settlementHook[0], setSettlementAccess = settlementHook[1];
    var keyHook = React.useState("");
    var adminKey = keyHook[0], setAdminKey = keyHook[1];
    var tabHook = React.useState("sale");
    var activeTab = tabHook[0], setActiveTab = tabHook[1];
    var menuHook = React.useState(false);
    var mobileMenuOpen = menuHook[0], setMobileMenuOpen = menuHook[1];
    var catHook = React.useState("cat_earring");
    var activeCategoryId = catHook[0], setActiveCategoryId = catHook[1];
    var customerHook = React.useState("customer_walkin");
    var selectedCustomerId = customerHook[0], setSelectedCustomerId = customerHook[1];
    var recentCustomerHook = React.useState(readRecentCustomers);
    var recentCustomerIds = recentCustomerHook[0], setRecentCustomerIds = recentCustomerHook[1];
    var manualCustomerHook = React.useState("");
    var manualCustomerName = manualCustomerHook[0], setManualCustomerName = manualCustomerHook[1];
    var writerHook = React.useState("writer_default");
    var selectedWriterId = writerHook[0], setSelectedWriterId = writerHook[1];
    var vatHook = React.useState(true);
    var vatChecked = vatHook[0], setVatChecked = vatHook[1];
    var cartHook = React.useState([]);
    var cart = cartHook[0], setCart = cartHook[1];
    var printHook = React.useState(null);
    var printSale = printHook[0], setPrintSale = printHook[1];
    var catalogDiscountHook = React.useState(false);
    var catalogDiscount = catalogDiscountHook[0], setCatalogDiscount = catalogDiscountHook[1];
    var addQuantityHook = React.useState(null);
    var pendingItemAddition = addQuantityHook[0], setPendingItemAddition = addQuantityHook[1];
    var writerPromptHook = React.useState(false);
    var writerPromptOpen = writerPromptHook[0], setWriterPromptOpen = writerPromptHook[1];
    var saleEditHook = React.useState(null);
    var saleBeingEdited = saleEditHook[0], setSaleBeingEdited = saleEditHook[1];
    var cloudLoadedRef = React.useRef(false);
    var cloudApplyRef = React.useRef(false);
    var lastBackRef = React.useRef(0);
    var exitNoticeHook = React.useState(false);
    var exitNotice = exitNoticeHook[0], setExitNotice = exitNoticeHook[1];
    var cloudStatusHook = React.useState("connecting");
    var cloudStatus = cloudStatusHook[0], setCloudStatus = cloudStatusHook[1];
    var onlineHook = React.useState(typeof navigator === "undefined" ? true : navigator.onLine !== false);
    var online = onlineHook[0], setOnline = onlineHook[1];
    var saveNoticeHook = React.useState(null);
    var saveNotice = saveNoticeHook[0], setSaveNotice = saveNoticeHook[1];
    var deletionLogsHook = React.useState([]);
    var deletionLogs = deletionLogsHook[0], setDeletionLogs = deletionLogsHook[1];
    var reviewHook = React.useState(null);
    var reviewDraft = reviewHook[0], setReviewDraft = reviewHook[1];

    React.useEffect(function () {
      function handleCloudStatus(event) {
        setCloudStatus(event && event.detail && event.detail.status || "connecting");
      }
      window.addEventListener("pors-cloud-status", handleCloudStatus);
      return function () { window.removeEventListener("pors-cloud-status", handleCloudStatus); };
    }, []);

    React.useEffect(function () {
      function updateOnlineStatus() {
        setOnline(typeof navigator === "undefined" ? true : navigator.onLine !== false);
      }
      updateOnlineStatus();
      window.addEventListener("online", updateOnlineStatus);
      window.addEventListener("offline", updateOnlineStatus);
      return function () {
        window.removeEventListener("online", updateOnlineStatus);
        window.removeEventListener("offline", updateOnlineStatus);
      };
    }, []);

    React.useEffect(function () {
      if (!saveNotice) return undefined;
      var timer = window.setTimeout(function () { setSaveNotice(null); }, 2600);
      return function () { window.clearTimeout(timer); };
    }, [saveNotice]);

    function showSaveNotice(type, message) {
      setSaveNotice({ type: type, message: message });
    }

    function cloudStatusText() {
      if (!online) return "오프라인 · 이 기기에 임시 저장";
      if (cloudStatus === "saving") return "Firebase 저장 중";
      if (cloudStatus === "synced") return "Firebase 동기화 완료";
      if (cloudStatus === "error") return "Firebase 연결 오류";
      return "Firebase 연결 중";
    }

    function stateFromCloud(cloudState) {
      return normalizeState(Object.assign(clone(seed), cloudState, {
        categories: Array.isArray(cloudState.categories) ? cloudState.categories : seed.categories,
        items: Array.isArray(cloudState.items) ? cloudState.items : seed.items,
        customers: Array.isArray(cloudState.customers) ? cloudState.customers : seed.customers,
        writers: Array.isArray(cloudState.writers) ? cloudState.writers : seed.writers,
        groups: Array.isArray(cloudState.groups) ? cloudState.groups : seed.groups,
        sales: Array.isArray(cloudState.sales) ? cloudState.sales.slice(0, MAX_SALES) : []
      }));
    }

    function queueCatalogUpgrade(cloudState, nextState) {
      if (num(cloudState.dataVersion) === DATA_VERSION) return;
      window.setTimeout(function () { pushCloudState(nextState); }, 0);
    }

    React.useEffect(function () {
      var cancelled = false;
      pullCloudState().then(function (cloudState) {
        if (cancelled) return;
        cloudLoadedRef.current = true;
        if (!cloudState) {
          pushCloudState(state);
          return;
        }
        rawSetState(function (current) {
          var currentUpdatedAt = num(current.clientUpdatedAt);
          var cloudUpdatedAt = num(cloudState.clientUpdatedAt);
          if (cloudUpdatedAt <= currentUpdatedAt) {
            pushCloudState(current);
            return current;
          }
          cloudApplyRef.current = true;
          var nextState = stateFromCloud(cloudState);
          queueCatalogUpgrade(cloudState, nextState);
          return nextState;
        });
      }).catch(function () {
        cloudLoadedRef.current = true;
      });
      return function () {
        cancelled = true;
      };
    }, []);

    React.useEffect(function () {
      return subscribeCloudState(function (cloudState) {
        rawSetState(function (current) {
          if (num(cloudState.clientUpdatedAt) <= num(current.clientUpdatedAt)) return current;
          cloudApplyRef.current = true;
          var nextState = stateFromCloud(cloudState);
          queueCatalogUpgrade(cloudState, nextState);
          return nextState;
        });
      });
    }, []);

    React.useEffect(function () {
      return subscribeSalesCollection(function (sales) {
        rawSetState(function (current) {
          return Object.assign({}, current, {
            sales: sales.slice(0, MAX_SALES),
            clientUpdatedAt: Math.max(num(current.clientUpdatedAt), sales.reduce(function (latest, sale) { return Math.max(latest, num(sale.cloudUpdatedAt)); }, 0))
          });
        });
      });
    }, []);

    React.useEffect(function () {
      return subscribeManagementCollections(function (key, rows, latestCloudUpdate) {
        rawSetState(function (current) {
          if (key === "customers") {
            var originalRows = rows || [];
            rows = reconcileCustomerRenames(originalRows.map(normalizeCustomer));
            if (JSON.stringify(originalRows.map(cleanRemoteRow)) !== JSON.stringify(rows)) {
              syncManagementDiff({ customers: originalRows }, { customers: rows });
            }
          }
          if (JSON.stringify(current[key] || []) === JSON.stringify(rows || [])) return current;
          var patch = {};
          patch[key] = rows;
          patch.clientUpdatedAt = Math.max(num(current.clientUpdatedAt), latestCloudUpdate);
          return Object.assign({}, current, patch);
        });
      });
    }, []);

    React.useEffect(function () {
      if (!settlementAccess) return undefined;
      return subscribeDeletionLogs(function (logs) {
        setDeletionLogs(logs);
      });
    }, [settlementAccess]);

    React.useEffect(function () {
      saveState(state);
      if (cloudApplyRef.current) {
        cloudApplyRef.current = false;
        return;
      }
      if (!cloudLoadedRef.current) return;
      pushCloudState(state);
    }, [state]);

    React.useEffect(function () {
      return registerMobileBackHandler(function () {
        if (printSale) {
          setPrintSale(null);
          return true;
        }
        if (writerPromptOpen) {
          setWriterPromptOpen(false);
          return true;
        }
        if (pendingItemAddition) {
          setPendingItemAddition(null);
          return true;
        }
        if (saleBeingEdited) {
          cancelSaleEdit();
          return true;
        }
        if (mobileMenuOpen) {
          setMobileMenuOpen(false);
          return true;
        }
        if (activeTab !== "sale") {
          setActiveTab("sale");
          setMobileMenuOpen(false);
          return true;
        }
        var now = Date.now();
        if (now - lastBackRef.current < 1600) return false;
        lastBackRef.current = now;
        setExitNotice(true);
        window.setTimeout(function () { setExitNotice(false); }, 1500);
        return true;
      });
    }, [printSale, writerPromptOpen, pendingItemAddition, saleBeingEdited, mobileMenuOpen, activeTab]);

    var categories = (state.categories || []).filter(function (c) { return c.active; }).sort(function (a, b) { return a.sort - b.sort; });
    var customers = (state.customers || []).filter(function (c) { return c.active; });
    var writers = (state.writers || []).filter(function (writer) { return writer.active; });
    var manualCustomer = {
      id: MANUAL_CUSTOMER_ID,
      name: safeText(manualCustomerName) || "수기 거래처",
      discountRate: 0,
      vatEnabled: false,
      active: true,
      note: "수기 입력"
    };
    var customer = selectedCustomerId === MANUAL_CUSTOMER_ID ? manualCustomer : customers.find(function (c) { return c.id === selectedCustomerId; }) || customers[0];
    var writer = writers.find(function (entry) { return entry.id === selectedWriterId; }) || writers[0];
    var items = (state.items || []).filter(function (item) { return item.active && item.categoryId === activeCategoryId; });
    var vatBlocked = isVatExemptCustomer(customer);
    var effectiveVatChecked = vatChecked && !vatBlocked;
    var total = totals(cart, Object.assign({}, customer, { vatEnabled: effectiveVatChecked }));
    var todaySummary = salesSummaryForDate(state.sales || [], new Date());

    function selectCustomerWithVat(customerId) {
      setSelectedCustomerId(customerId);
      setVatChecked(true);
      if (customerId && customerId !== MANUAL_CUSTOMER_ID) {
        setRecentCustomerIds(function (current) {
          var next = [customerId].concat((current || []).filter(function (idValue) { return idValue !== customerId; })).slice(0, 8);
          saveRecentCustomers(next);
          return next;
        });
      }
    }

    function login(event) {
      event.preventDefault();
      if (loginLocked()) {
        alert("로그인 시도가 많습니다. 5분 뒤 다시 시도해 주세요.");
        return;
      }
      var configuredKey = window.PIERCE_ADMIN_KEY || state.store.adminKey;
      var settlementLogin = adminKey === "1226";
      if (!settlementLogin && adminKey !== configuredKey && adminKey !== state.store.adminKey) {
        recordLoginFailure();
        alert("관리자키가 맞지 않습니다. 기본키는 0000입니다.");
        return;
      }
      writeAuth(settlementLogin);
      setAuthorized(true);
      setSettlementAccess(settlementLogin);
    }

    function addItem(item, forceNewLine, override) {
      var groupedLine = ["cat_other", "cat_surgical", "cat_clay"].indexOf(item.categoryId) >= 0 && item.groupName;
      var baseLineName = item.categoryId === "cat_earring" ? "피어싱" : item.categoryId === "cat_silver" ? "실버" : groupedLine ? item.groupName + " " + item.name : item.name;
      var lineName = override && override.name ? safeText(override.name) : safeText(baseLineName);
      var customerPrice = override && override.price != null ? null : customerPriceForItem(item, customer);
      var linePrice = override && override.price != null ? override.price : customerPrice != null ? customerPrice : item.price;
      var lineDiscountable = override && override.discountable != null ? override.discountable : item.categoryId !== "cat_no_discount" && item.discountable !== false && itemDiscountable(item.categoryId, categories);
      var lineItemId = override && override.itemId ? override.itemId : item.id;
      var lineQuantity = override && override.quantity != null ? clamp(override.quantity, 1, MAX_QUANTITY) : 1;
      var lineOriginalPrice = override && override.originalPrice != null ? clamp(override.originalPrice, 0, MAX_PRICE) : null;
      var existing = forceNewLine ? null : cart.find(function (line) { return line.itemId === lineItemId; });
      if (existing) {
        setPendingItemAddition({ lineId: existing.id, name: existing.name, currentQuantity: existing.quantity });
        return;
      }
      setCart(function (current) {
        return current.concat([{ id: id("line"), itemId: forceNewLine ? id("manual_item") : lineItemId, categoryId: item.categoryId || "", groupName: item.groupName || "", name: lineName, price: clamp(linePrice, 0, MAX_PRICE), originalPrice: lineOriginalPrice, quantity: lineQuantity, discountable: lineDiscountable }]);
      });
    }

    function addPendingItemQuantity(amount) {
      var addition = clamp(amount, 1, MAX_QUANTITY);
      if (!pendingItemAddition || addition < 1) return;
      setCart(function (current) {
        return current.map(function (line) {
          return line.id === pendingItemAddition.lineId ? Object.assign({}, line, { quantity: Math.min(MAX_QUANTITY, line.quantity + addition) }) : line;
        });
      });
      setPendingItemAddition(null);
    }

    function chooseItems(items) {
      var item = items[0];
      var discounted = catalogDiscountApplies(item, catalogDiscount);
      if (discounted) {
        var baseName = safeText(item.categoryId === "cat_earring" ? "피어싱" : "실버");
        var discountRate = item.categoryId === "cat_silver" ? 0.05 : 0.1;
        var discountLabel = item.categoryId === "cat_silver" ? "5% 할인" : "10% 할인";
        addItem(item, false, {
          itemId: item.id + (item.categoryId === "cat_silver" ? "_discount5" : "_discount10"),
          name: baseName + " " + discountLabel,
          price: Math.round(num(item.price) * (1 - discountRate)),
          originalPrice: item.price,
          quantity: item.categoryId === "cat_silver" ? 50 : 100,
          discountable: false
        });
        return;
      }
      addItem(item, false);
    }

    function updateLine(lineId, patch) {
      setCart(function (current) {
        return current.map(function (line) {
          if (line.id !== lineId) return line;
          return Object.assign({}, line, patch, {
            price: clamp(patch.price == null ? line.price : patch.price, 0, MAX_PRICE),
            quantity: clamp(patch.quantity == null ? line.quantity : patch.quantity, 0, MAX_QUANTITY)
          });
        }).filter(function (line) { return line.quantity > 0; });
      });
    }

    function buildSaleDraft(saleWriter) {
      var shippingFee = 0;
      var saleTotal = total;
      if (saleBeingEdited) {
        var changes = saleEditChanges(saleBeingEdited, cart, customer, saleWriter, effectiveVatChecked, shippingFee);
        return {
          mode: "edit",
          writer: saleWriter,
          shippingFee: shippingFee,
          totals: saleTotal,
          changes: changes,
          sale: buildEditedSale(saleBeingEdited, Object.assign({}, saleBeingEdited, {
            customerId: customer.id,
            customerName: customer.name,
            writerName: safeText(saleWriter.name),
            discountRate: customer.discountRate,
            customerNote: customerRuleSummary(customer),
            customerPricingRules: customer.pricingRules || [],
            customerDiscountRules: customer.discountRules || [],
            vatEnabled: effectiveVatChecked,
            vatExempt: vatBlocked,
            shippingFee: shippingFee,
            offshoreSettlement: offshoreSettlementForTotal(saleTotal, customer),
            lines: cart,
            totals: saleTotal
          }), changes, safeText(saleWriter.name))
        };
      }
      return {
        mode: "new",
        writer: saleWriter,
        shippingFee: shippingFee,
        totals: saleTotal,
        sale: {
          id: id("sale"),
          createdAt: new Date().toISOString(),
          customerId: customer.id,
          customerName: customer.name,
          writerName: safeText(saleWriter.name),
          discountRate: customer.discountRate,
          customerNote: customerRuleSummary(customer),
          customerPricingRules: customer.pricingRules || [],
          customerDiscountRules: customer.discountRules || [],
          vatEnabled: effectiveVatChecked,
          vatExempt: vatBlocked,
          shippingFee: shippingFee,
          offshoreSettlement: offshoreSettlementForTotal(saleTotal, customer),
          lines: cart,
          totals: saleTotal
        }
      };
    }

    function requestSaveSale(writerOverride) {
      if (!cart.length) {
        alert("품목을 먼저 추가해 주세요.");
        return;
      }
      var saleWriter = writerOverride && writerOverride.id ? writerOverride : null;
      if (!saleWriter || saleWriter.id === "writer_default") {
        setWriterPromptOpen(true);
        return;
      }
      var draft = buildSaleDraft(saleWriter);
      if (draft.mode === "edit" && !draft.changes.length) {
        alert("변경된 내용이 없습니다.");
        return;
      }
      setReviewDraft(draft);
      setWriterPromptOpen(false);
    }

    function confirmSaveSale() {
      if (!reviewDraft || !reviewDraft.sale) return;
      var sale = reviewDraft.sale;
      if (reviewDraft.mode === "edit") {
        updateSale(sale);
        upsertSaleDocument(sale).then(function (ok) {
          showSaveNotice(ok && online ? "success" : "warning", ok && online ? "수정 내역 저장 완료" : "이 기기에 저장됨 · Firebase 연결 확인 필요");
        });
        setCart([]);
        setSelectedWriterId(reviewDraft.writer.id);
        setWriterPromptOpen(false);
        setSaleBeingEdited(null);
        setReviewDraft(null);
        setPrintSale(sale);
        return;
      }
      setState(function (current) { return Object.assign({}, current, { sales: [sale].concat(current.sales).slice(0, MAX_SALES) }); });
      upsertSaleDocument(sale).then(function (ok) {
        showSaveNotice(ok && online ? "success" : "warning", ok && online ? "판매 내역 저장 완료" : "이 기기에 저장됨 · Firebase 연결 확인 필요");
      });
      setCart([]);
      setSelectedWriterId(reviewDraft.writer.id);
      setWriterPromptOpen(false);
      setReviewDraft(null);
      setPrintSale(sale);
    }

    function deleteSale(sale, reason) {
      if (!sale || !sale.id) return;
      if (!settlementAccess) return;
      reason = safeText(reason) || "사유 미입력";
      var deletedAt = new Date().toISOString();
      var deletionLog = {
        id: id("delete"),
        saleId: sale.id,
        deletedAt: deletedAt,
        reason: reason,
        admin: "관리자(1226)",
        customerName: sale.customerName || "-",
        writerName: sale.writerName || "-",
        createdAt: sale.createdAt,
        totals: sale.totals || {},
        lineCount: (sale.lines || []).length,
        quantity: (sale.lines || []).reduce(function (sum, line) { return sum + num(line.quantity); }, 0)
      };
      setState(function (current) {
        return Object.assign({}, current, { sales: (current.sales || []).filter(function (entry) { return entry.id !== sale.id; }) });
      });
      setDeletionLogs(function (current) { return [deletionLog].concat(current || []).slice(0, 200); });
      upsertDeletionLog(deletionLog);
      deleteSaleDocument(sale.id);
      setPrintSale(function (current) { return current && current.id === sale.id ? null : current; });
    }

    function buildEditedSale(originalSale, nextSale, changes, editorName) {
      var nextLines = (nextSale.lines || originalSale.lines || []).filter(function (line) { return num(line.quantity) > 0; });
      var editedAt = new Date().toISOString();
      return Object.assign({}, originalSale, nextSale, {
        lines: nextLines,
        updatedAt: editedAt,
        editHistory: (originalSale.editHistory || []).concat([{
          id: id("sale_edit"),
          editedAt: editedAt,
          editor: settlementAccess ? "관리자(1226) · " + (editorName || "-") : "회원 · " + (editorName || "-"),
          changes: changes
        }])
      });
    }

    function updateSale(nextSale) {
      if (!nextSale || !nextSale.id) return;
      setState(function (current) {
        return Object.assign({}, current, {
          sales: (current.sales || []).map(function (sale) {
            return sale.id === nextSale.id ? nextSale : sale;
          })
        });
      });
    }

    function saleEditChanges(original, nextLines, nextCustomer, nextWriter, nextVatEnabled, nextShippingFee) {
      var changes = [];
      if (safeText(original.customerName) !== safeText(nextCustomer.name)) changes.push("거래처: " + (original.customerName || "-") + " → " + (nextCustomer.name || "-"));
      if (safeText(original.writerName) !== safeText(nextWriter.name)) changes.push("작성자: " + (original.writerName || "-") + " → " + (nextWriter.name || "-"));
      if (!!original.vatEnabled !== !!nextVatEnabled) changes.push("VAT: " + (original.vatEnabled ? "적용" : "미적용") + " → " + (nextVatEnabled ? "적용" : "미적용"));
      if (num(original.shippingFee || (original.totals || {}).shippingFee) !== num(nextShippingFee)) changes.push("배송비: " + won(original.shippingFee || (original.totals || {}).shippingFee) + " → " + won(nextShippingFee));
      (original.lines || []).forEach(function (line) {
        var nextLine = nextLines.find(function (entry) { return entry.id === line.id; });
        if (!nextLine) {
          changes.push("품목 삭제: " + line.name + " " + line.quantity + "개");
          return;
        }
        if (num(line.quantity) !== num(nextLine.quantity)) changes.push(line.name + " 수량: " + line.quantity + " → " + nextLine.quantity);
        if (num(line.price) !== num(nextLine.price)) changes.push(line.name + " 단가: " + won(line.price) + " → " + won(nextLine.price));
      });
      nextLines.forEach(function (line) {
        if (!(original.lines || []).some(function (entry) { return entry.id === line.id; })) changes.push("품목 추가: " + line.name + " " + line.quantity + "개 · " + won(line.price));
      });
      return changes;
    }

    function beginSaleEdit(sale) {
      var matchedCustomer = customers.find(function (entry) { return entry.id === sale.customerId; }) || customers.find(function (entry) { return safeText(entry.name) === safeText(sale.customerName); });
      var matchedWriter = writers.find(function (entry) { return safeText(entry.name) === safeText(sale.writerName); });
      setSaleBeingEdited(sale);
      setCart(clone(sale.lines || []));
      if (matchedCustomer) {
        setSelectedCustomerId(matchedCustomer.id);
        setManualCustomerName("");
      } else {
        setSelectedCustomerId(MANUAL_CUSTOMER_ID);
        setManualCustomerName(sale.customerName || "");
      }
      setSelectedWriterId(matchedWriter ? matchedWriter.id : "writer_default");
      setVatChecked(!!sale.vatEnabled);
      setActiveTab("sale");
      setMobileMenuOpen(false);
    }

    function cancelSaleEdit() {
      setSaleBeingEdited(null);
      setCart([]);
    }

    function selectManualCustomer(name) {
      var cleanName = safeText(name);
      if (!cleanName) return;
      var cleanKey = customerSearchKey(cleanName);
      var existing = (state.customers || []).find(function (customer) { return customerSearchKey(customer.name) === cleanKey; });
      if (existing) {
        selectCustomerWithVat(existing.id);
        setManualCustomerName("");
        return;
      }
      var newCustomer = {
        id: id("customer"),
        name: cleanName,
        discountRate: 0,
        vatEnabled: false,
        active: true,
        note: "",
        pricingRules: [],
        discountRules: []
      };
      setState(function (current) {
        var duplicate = (current.customers || []).find(function (customer) { return customerSearchKey(customer.name) === cleanKey; });
        if (duplicate) return current;
        return Object.assign({}, current, { customers: (current.customers || []).concat([newCustomer]) });
      });
      selectCustomerWithVat(newCustomer.id);
      setManualCustomerName("");
    }

    if (!authorized) return h("main", { className: "login-screen" },
      h("section", { className: "login-card" },
        h("div", { className: "brand-mark" }, "P"),
        h("h1", null, "피어싱 계산"),
        h("p", null, "관리자키를 입력하면 계산, 품목관리, 영수증 출력을 바로 사용할 수 있습니다."),
        h("form", { onSubmit: login },
          h("label", null, "관리자키"),
          h("input", { value: adminKey, onChange: function (e) { setAdminKey(e.target.value); }, placeholder: "0000", type: "password", autoFocus: true }),
          h("button", { className: "primary", type: "submit" }, "시작하기")
        ),
        h("small", null, "파일 직접 실행 모드")
      )
    );

    return h(React.Fragment, null,
      h("div", { className: "app-shell" },
        h("header", { className: "topbar" },
          h("div", { className: "brand-row" },
            h("strong", null, state.store.name),
            h("span", null, "APK ready"),
            h(CustomerPicker, { className: "header-customer", customers: customers, recentCustomerIds: recentCustomerIds, selectedCustomerId: selectedCustomerId, setSelectedCustomerId: selectCustomerWithVat, manualCustomerName: manualCustomerName, setManualCustomerName: setManualCustomerName, onManualCustomer: selectManualCustomer, compact: true })
          ),
          h("button", { className: "mobile-menu-button", type: "button", "aria-label": "메뉴", "aria-expanded": mobileMenuOpen, onClick: function () { setMobileMenuOpen(!mobileMenuOpen); } },
            h("span", null),
            h("span", null),
            h("span", null)
          ),
          h("nav", { className: mobileMenuOpen ? "open" : "" },
            h("small", { className: "cloud-status " + (!online ? "offline" : cloudStatus) }, cloudStatusText()),
            [["sale", "계산"], ["manage", "관리"], ["history", "내역"]].map(function (entry) {
            return h("button", { key: entry[0], className: activeTab === entry[0] ? "active" : "", onClick: function () { setActiveTab(entry[0]); setMobileMenuOpen(false); } }, entry[1]);
          }))
        ),
        activeTab === "sale" && h(SaleScreen, { categories: categories, activeCategoryId: activeCategoryId, setActiveCategoryId: setActiveCategoryId, items: items, customers: customers, recentCustomerIds: recentCustomerIds, selectedCustomerId: selectedCustomerId, setSelectedCustomerId: selectCustomerWithVat, manualCustomerName: manualCustomerName, setManualCustomerName: setManualCustomerName, onManualCustomer: selectManualCustomer, writers: writers, selectedWriterId: selectedWriterId, setSelectedWriterId: setSelectedWriterId, cart: cart, updateLine: updateLine, chooseItems: chooseItems, catalogDiscount: catalogDiscount, setCatalogDiscount: setCatalogDiscount, total: total, customer: customer, vatChecked: effectiveVatChecked, vatBlocked: vatBlocked, setVatChecked: setVatChecked, saveSale: requestSaveSale, clearCart: function () { setCart([]); }, totalQuantity: cart.reduce(function (sum, line) { return sum + num(line.quantity); }, 0), saleBeingEdited: saleBeingEdited, cancelSaleEdit: cancelSaleEdit, todaySummary: todaySummary }),
        activeTab === "manage" && h(ManageScreen, { state: state, setState: setState }),
        activeTab === "history" && h(HistoryScreen, { sales: state.sales, deletionLogs: deletionLogs, setPrintSale: setPrintSale, settlementAccess: settlementAccess, deleteSale: deleteSale, beginSaleEdit: beginSaleEdit })
      ),
      printSale && h(PrintSheet, { sale: printSale, store: state.store, onClose: function () { setPrintSale(null); } }),
      saveNotice ? h("div", { className: "save-toast " + saveNotice.type, role: "status" }, saveNotice.message) : null,
      exitNotice ? h("div", { className: "mobile-back-toast", role: "status" }, "한 번 더 누르면 앱이 종료됩니다.") : null,
      pendingItemAddition && h(AddQuantityModal, { item: pendingItemAddition, onConfirm: addPendingItemQuantity, onClose: function () { setPendingItemAddition(null); } }),
      writerPromptOpen && h("div", { className: "writer-modal", role: "dialog", "aria-modal": true },
        h("section", { className: "writer-modal-card" },
          h("h2", null, "작성자 선택"),
          h("div", { className: "writer-button-grid" }, writers.filter(function (entry) { return entry.id !== "writer_default"; }).map(function (entry) {
            return h("button", { key: entry.id, type: "button", onClick: function () { requestSaveSale(entry); } }, entry.name);
          })),
          h("button", { className: "ghost", type: "button", onClick: function () { setWriterPromptOpen(false); } }, "취소")
        )
      ),
      reviewDraft && h(SaleReviewModal, { draft: reviewDraft, onConfirm: confirmSaveSale, onClose: function () { setReviewDraft(null); } }
      )
    );
  }

  function SaleReviewModal(props) {
    var sale = props.draft.sale || {};
    var totalsValue = sale.totals || {};
    var lines = sale.lines || [];
    var quantity = lines.reduce(function (sum, line) { return sum + num(line.quantity); }, 0);
    return h("div", { className: "writer-modal", role: "dialog", "aria-modal": true },
      h("section", { className: "writer-modal-card sale-review-card" },
        h("h2", null, props.draft.mode === "edit" ? "수정 전 확인" : "저장 전 확인"),
        h("div", { className: "sale-review-grid" },
          h("span", null, "거래처"), h("strong", null, sale.customerName || "-"),
          h("span", null, "작성자"), h("strong", null, sale.writerName || "-"),
          h("span", null, "품목/수량"), h("strong", null, lines.length + "종 · " + quantity + "개"),
          h("span", null, "상품합계"), h("strong", null, won(totalsValue.subtotal)),
          h("span", null, "할인"), h("strong", null, "-" + won(totalsValue.discount)),
          h("span", null, "VAT"), h("strong", null, won(totalsValue.vat)),
          h("span", null, "총액"), h("b", null, won(totalsValue.total))
        ),
        props.draft.changes && props.draft.changes.length ? h("div", { className: "sale-review-changes" },
          h("strong", null, "수정 내용"),
          h("ul", null, props.draft.changes.map(function (change, index) { return h("li", { key: index }, change); }))
        ) : null,
        h("div", { className: "review-actions" },
          h("button", { className: "ghost", type: "button", onClick: props.onClose }, "취소"),
          h("button", { className: "primary", type: "button", onClick: props.onConfirm }, "확인 후 출력")
        )
      )
    );
  }

  function AddQuantityModal(props) {
    var quantityHook = React.useState("");
    var quantity = quantityHook[0], setQuantity = quantityHook[1];
    var parsedQuantity = Math.max(0, Math.floor(num(quantity)));
    function submit(event) {
      event.preventDefault();
      if (parsedQuantity < 1) return;
      props.onConfirm(parsedQuantity);
    }
    return h("div", { className: "writer-modal", role: "dialog", "aria-modal": true },
      h("form", { className: "writer-modal-card add-quantity-modal", onSubmit: submit },
        h("h2", null, "수량 추가"),
        h("p", null, props.item.name + " · 현재 " + props.item.currentQuantity + "개"),
        h("label", null,
          h("span", null, "추가할 수량"),
          h("input", {
            value: quantity,
            inputMode: "numeric",
            pattern: "[0-9]*",
            autoFocus: true,
            placeholder: "예: 30",
            onChange: function (event) { setQuantity(String(event.target.value || "").replace(/[^\d]/g, "").slice(0, 3)); }
          })
        ),
        h("div", { className: "add-quantity-actions" },
          h("button", { className: "ghost", type: "button", onClick: props.onClose }, "취소"),
          h("button", { className: "primary", type: "submit", disabled: parsedQuantity < 1 }, parsedQuantity > 0 ? parsedQuantity + "개 추가" : "추가")
        )
      )
    );
  }

  function CustomerPicker(props) {
    var openHook = React.useState(false);
    var open = openHook[0], setOpen = openHook[1];
    var queryHook = React.useState("");
    var query = queryHook[0], setQuery = queryHook[1];
    var customers = props.customers || [];
    var manualName = safeText(props.manualCustomerName);
    var selected = props.selectedCustomerId === MANUAL_CUSTOMER_ID ? {
      id: MANUAL_CUSTOMER_ID,
      name: manualName || "수기 거래처",
      discountRate: 0,
      note: "수기"
    } : customers.find(function (customer) { return customer.id === props.selectedCustomerId; }) || customers[0] || {};
    var cleanQuery = safeText(query).toLowerCase();
    var cleanQueryKey = customerSearchKey(query);
    var manualQuery = safeText(query);
    var exactCustomer = customers.find(function (customer) { return customerSearchKey(customer.name) === cleanQueryKey; });
    var recentCustomers = (props.recentCustomerIds || []).map(function (customerId) {
      return customers.find(function (customer) { return customer.id === customerId; });
    }).filter(Boolean).filter(function (customer, index, array) {
      return array.findIndex(function (entry) { return entry.id === customer.id; }) === index;
    }).slice(0, 5);
    var filtered = customers.filter(function (customer) {
      if (!cleanQuery) return false;
      return customerSearchKey(customer.name).indexOf(cleanQueryKey) >= 0 ||
        safeText(customer.note || "").toLowerCase().indexOf(cleanQuery) >= 0 ||
        String(customer.discountRate || "").indexOf(cleanQuery) >= 0;
    }).sort(function (a, b) {
      if (!cleanQuery) {
        if (a.id === "customer_walkin") return -1;
        if (b.id === "customer_walkin") return 1;
        if (a.id === selected.id) return -1;
        if (b.id === selected.id) return 1;
      }
      return String(a.name).localeCompare(String(b.name), "ko-KR");
    });
    function choose(customer) {
      props.setSelectedCustomerId(customer.id);
      if (props.setManualCustomerName) props.setManualCustomerName("");
      setOpen(false);
      setQuery("");
    }
    function submitSearch(event) {
      if (event && event.preventDefault) event.preventDefault();
      var submittedQuery = safeText(event && event.currentTarget && event.currentTarget.elements && event.currentTarget.elements[0] ? event.currentTarget.elements[0].value : manualQuery);
      if (!submittedQuery) return;
      var submittedKey = customerSearchKey(submittedQuery);
      var submittedCustomer = customers.find(function (customer) { return customerSearchKey(customer.name) === submittedKey; });
      if (submittedCustomer) {
        choose(submittedCustomer);
        return;
      }
      if (props.onManualCustomer) {
        props.onManualCustomer(submittedQuery);
        setOpen(false);
        setQuery("");
        return;
      }
      if (props.setManualCustomerName) props.setManualCustomerName(submittedQuery);
      props.setSelectedCustomerId(MANUAL_CUSTOMER_ID);
      setOpen(false);
      setQuery("");
    }
    React.useEffect(function () {
      if (!open) return undefined;
      return registerMobileBackHandler(function () {
        setOpen(false);
        setQuery("");
        return true;
      });
    }, [open]);
    function customerDisplayName(name) {
      var raw = String(name || "");
      var match = raw.match(/^(.*?)(\s*\(.+\))$/);
      return {
        main: match ? match[1].trim() : raw,
        detail: match ? match[2].trim() : ""
      };
    }
    return h("div", { className: (props.className || "customer-picker") + (props.compact ? " compact" : "") },
      h("span", { className: "customer-picker-label" }, "거래처"),
      h("button", { className: "customer-picker-button", type: "button", onClick: function () { setOpen(true); } },
        h("strong", null, selected.name || "거래처 선택"),
        h("small", null, selected.id === MANUAL_CUSTOMER_ID ? "수기 입력 · 할인 0%" : (selected.discountRate || 0) + "%" + (selected.note ? " · 기타" : "")),
        h("i", null, "⌄")
      ),
      open ? h("div", { className: "customer-picker-layer", role: "dialog", "aria-modal": true },
        h("button", { className: "customer-picker-backdrop", type: "button", "aria-label": "닫기", onClick: function () { setOpen(false); setQuery(""); } }),
        h("section", { className: "customer-picker-panel" },
          h("div", { className: "customer-picker-head" },
            h("strong", null, "거래처 검색"),
            h("button", { className: "ghost small", type: "button", onClick: function () { setOpen(false); setQuery(""); } }, "닫기")
          ),
          h("form", { className: "customer-search-form", onSubmit: submitSearch },
            h("input", { className: "customer-search", value: query, onChange: function (event) { setQuery(event.target.value); }, placeholder: "거래처명 검색", autoFocus: true }),
            h("button", { className: "primary customer-search-submit", type: "submit", disabled: !manualQuery }, "확인")
          ),
          recentCustomers.length ? h("div", { className: "frequent-customers" },
            h("div", { className: "frequent-customers-head" }, h("strong", null, "자주 쓰는 거래처")),
            h("div", { className: "frequent-customer-list" }, recentCustomers.map(function (customer) {
              var displayName = customerDisplayName(customer.name);
              return h("button", { key: customer.id, type: "button", className: customer.id === selected.id ? "active" : "", onClick: function () { choose(customer); } },
                h("strong", null, displayName.main),
                displayName.detail ? h("small", null, displayName.detail) : null,
                h("b", null, (customer.discountRate || 0) + "%")
              );
            }))
          ) : null,
          h("div", { className: "customer-result-list" },
            filtered.length ? filtered.map(function (customer) {
              var displayName = customerDisplayName(customer.name);
              return h("button", { key: customer.id, type: "button", className: customer.id === selected.id ? "customer-result active" : "customer-result", onClick: function () { choose(customer); } },
                h("strong", null, displayName.main),
                displayName.detail ? h("small", null, displayName.detail) : null,
                h("b", null, "할인률 " + (customer.discountRate || 0) + "%")
              );
            }) : manualQuery ? h("p", { className: "empty" }, "일치하는 거래처가 없습니다. 확인을 누르면 새 거래처로 저장됩니다.") : h("p", { className: "empty" }, "거래처명을 입력하면 아래에 비슷한 거래처가 표시됩니다.")
          )
        )
      ) : null
    );
  }

  function SaleScreen(props) {
    var swipeStartHook = React.useState(null);
    var swipeStart = swipeStartHook[0], setSwipeStart = swipeStartHook[1];
    var slideHook = React.useState("");
    var slideDirection = slideHook[0], setSlideDirection = slideHook[1];
    var pressedHook = React.useState("");
    var pressedItemId = pressedHook[0], setPressedItemId = pressedHook[1];
    var cartLinesRef = React.useRef(null);
    var previousCartLengthRef = React.useRef(props.cart.length);
    React.useEffect(function () {
      var previousLength = previousCartLengthRef.current;
      previousCartLengthRef.current = props.cart.length;
      if (props.cart.length <= previousLength || !cartLinesRef.current) return;
      window.requestAnimationFrame(function () {
        if (!cartLinesRef.current) return;
        cartLinesRef.current.scrollTo({ top: cartLinesRef.current.scrollHeight, behavior: "smooth" });
      });
    }, [props.cart.length]);
    function sortedItems(items) {
      return items.slice().sort(function (a, b) {
        if (a.categoryId === "cat_earring" || a.categoryId === "cat_silver" || b.categoryId === "cat_earring" || b.categoryId === "cat_silver") {
          if (num(a.price) !== num(b.price)) return num(a.price) - num(b.price);
          return String(a.name).localeCompare(String(b.name), "ko-KR");
        }
        var aSort = a.sort == null ? Number.POSITIVE_INFINITY : num(a.sort);
        var bSort = b.sort == null ? Number.POSITIVE_INFINITY : num(b.sort);
        if (aSort !== bSort) return aSort - bSort;
        if (num(a.price) !== num(b.price)) return num(a.price) - num(b.price);
        return String(a.name).localeCompare(String(b.name), "ko-KR");
      });
    }
    var orderedItems = sortedItems(props.items);
    var usesPriceBands = props.activeCategoryId === "cat_earring" || props.activeCategoryId === "cat_silver";
    function itemSection(item) {
      if (usesPriceBands) return Math.max(1, Math.floor(num(item.price) / 1000)) + "천원대";
      return item.groupName || "";
    }
    var groups = Array.from(new Set(orderedItems.map(itemSection).filter(Boolean)));
    function moveCategory(direction) {
      var currentIndex = props.categories.findIndex(function (category) { return category.id === props.activeCategoryId; });
      var nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= props.categories.length) return;
      setSlideDirection(direction > 0 ? "left" : "right");
      props.setActiveCategoryId(props.categories[nextIndex].id);
      window.setTimeout(function () { setSlideDirection(""); }, 260);
    }
    function chooseCategory(categoryId) {
      var currentIndex = props.categories.findIndex(function (category) { return category.id === props.activeCategoryId; });
      var nextIndex = props.categories.findIndex(function (category) { return category.id === categoryId; });
      if (currentIndex >= 0 && nextIndex >= 0 && currentIndex !== nextIndex) {
        setSlideDirection(nextIndex > currentIndex ? "left" : "right");
        window.setTimeout(function () { setSlideDirection(""); }, 260);
      }
      props.setActiveCategoryId(categoryId);
    }
    function eventPoint(event) {
      var touch = event.changedTouches && event.changedTouches[0] || event.touches && event.touches[0];
      if (touch) return { x: touch.clientX, y: touch.clientY };
      if (event.clientX != null) return { x: event.clientX, y: event.clientY };
      return null;
    }
    function startSwipe(event) {
      var point = eventPoint(event);
      if (point) setSwipeStart(point);
    }
    function endSwipe(event) {
      if (!swipeStart) return;
      var point = eventPoint(event);
      setSwipeStart(null);
      if (!point) return;
      var dx = point.x - swipeStart.x;
      var dy = point.y - swipeStart.y;
      if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      moveCategory(dx < 0 ? 1 : -1);
    }
    function renderItemButton(item) {
      var discounted = catalogDiscountApplies(item, props.catalogDiscount);
      var salePrice = Math.round(num(item.price) * (item.categoryId === "cat_silver" ? 0.95 : 0.9));
      return h("button", { key: item.id, className: pressedItemId === item.id ? "item-tile just-added" : "item-tile", onClick: function () {
        setPressedItemId(item.id);
        window.setTimeout(function () { setPressedItemId(""); }, 180);
        props.chooseItems([item]);
      } },
        h("span", { className: item.categoryId === "cat_other" || item.categoryId === "cat_surgical" || item.categoryId === "cat_clay" || item.categoryId === "cat_parts" || item.categoryId === "cat_no_discount" ? "item-name prominent" : "item-name" }, item.name),
        discounted ? h("span", { className: "discount-price-stack" },
          h("strong", { className: "price-original" }, won(item.price)),
          h("strong", { className: "price-discounted" }, won(salePrice))
        ) : h("strong", { className: "price-regular" }, won(item.price))
      );
    }
    var customerNote = customerRuleSummary(props.customer);
    return h("main", { className: "sale-grid" },
      h("section", { className: "catalog-panel" },
        h("div", { className: "today-summary" },
          h("span", null, "오늘"),
          h("strong", null, (props.todaySummary && props.todaySummary.count || 0) + "건"),
          h("strong", null, (props.todaySummary && props.todaySummary.quantity || 0) + "개"),
          h("b", null, won(props.todaySummary && props.todaySummary.total || 0)),
          h("small", null, "VAT " + won(props.todaySummary && props.todaySummary.vat || 0))
        ),
        h("div", { className: "catalog-toolbar" },
          h("div", { className: "category-tabs" }, props.categories.map(function (c) {
            return h("button", { key: c.id, className: props.activeCategoryId === c.id ? "active" : "", onClick: function () { chooseCategory(c.id); } }, c.name);
          })),
          h("button", { className: props.catalogDiscount ? "discount-toggle active" : "discount-toggle", "aria-pressed": props.catalogDiscount, onClick: function () { props.setCatalogDiscount(!props.catalogDiscount); } },
            h("span", null, "할인"),
            h("i", null)
          )
        ),
        h("div", { className: "catalog-body", onPointerDown: startSwipe, onPointerUp: endSwipe, onPointerCancel: function () { setSwipeStart(null); }, onTouchStart: startSwipe, onTouchEnd: endSwipe },
          h("div", { key: props.activeCategoryId, className: "catalog-items" + (slideDirection ? " slide-" + slideDirection : "") },
            groups.length ? h("div", { className: "price-sections" }, groups.map(function (group) {
              var groupedItems = props.items.filter(function (item) { return itemSection(item) === group; });
              return h("section", { key: group, className: "price-section" },
                h("h3", null, group),
                h("div", { className: "item-grid" }, sortedItems(groupedItems).map(renderItemButton))
              );
            })) : h("div", { className: props.activeCategoryId === "cat_silver" ? "item-grid silver-grid" : "item-grid" }, sortedItems(props.items).map(renderItemButton))
          )
        )
      ),
      h("aside", { className: "cart-panel" + (props.saleBeingEdited ? " sale-editing" : "") + (!props.cart.length ? " cart-empty" : "") },
        h("div", { className: "meta-row" },
          h(CustomerPicker, { className: "customer-row", customers: props.customers, recentCustomerIds: props.recentCustomerIds, selectedCustomerId: props.selectedCustomerId, setSelectedCustomerId: props.setSelectedCustomerId, manualCustomerName: props.manualCustomerName, setManualCustomerName: props.setManualCustomerName, onManualCustomer: props.onManualCustomer }),
          h("div", { className: "writer-row" }, h("label", null, "작성자"),
            h("select", { value: props.selectedWriterId, onChange: function (e) { props.setSelectedWriterId(e.target.value); } }, (props.writers || []).map(function (writer) {
              return h("option", { key: writer.id, value: writer.id }, writer.name);
            }))
          )
        ),
        props.selectedWriterId === "writer_default" ? h("small", { className: "writer-note" }, "미정일 경우 저장 및 출력이 안됩니다.") : null,
        customerNote ? h("small", { className: "customer-note" }, customerNote) : null,
        h("div", { className: "cart-lines", ref: cartLinesRef }, props.cart.length ? props.cart.map(function (line, index) {
          return h(CartLine, { key: line.id, index: index, line: line, updateLine: props.updateLine, newest: index === props.cart.length - 1 });
        }) : h("p", { className: "empty" }, "품목을 눌러 장바구니에 담아 주세요.")),
        h(Totals, { total: props.total, totalQuantity: props.totalQuantity, customer: props.customer, vatChecked: props.vatChecked, vatBlocked: props.vatBlocked, setVatChecked: props.setVatChecked }),
        props.saleBeingEdited ? h("small", { className: "sale-edit-notice" }, "기존 내역 수정 중 · 품목을 추가하거나 삭제한 뒤 다시 저장하세요.") : null,
        h("div", { className: "action-row" },
          h("button", { className: "ghost", onClick: props.saleBeingEdited ? props.cancelSaleEdit : props.clearCart }, props.saleBeingEdited ? "수정 취소" : "비우기"),
          h("button", { className: "primary", onClick: function () { props.saveSale(); } }, h(Icon, { name: "print" }), props.saleBeingEdited ? "수정 저장/출력" : "저장/출력")
        )
      )
    );
  }

  function CartLine(props) {
    var line = props.line;
    var quantityTextHook = React.useState(String(line.quantity));
    var quantityText = quantityTextHook[0], setQuantityText = quantityTextHook[1];
    React.useEffect(function () {
      setQuantityText(String(line.quantity));
    }, [line.quantity]);
    function quickQuantity(amount) {
      props.updateLine(line.id, { quantity: line.quantity === 1 ? amount : line.quantity + amount });
    }
    function commitQuantity() {
      var nextQuantity = clamp(quantityText, 1, MAX_QUANTITY);
      setQuantityText(String(nextQuantity));
      props.updateLine(line.id, { quantity: nextQuantity });
    }
    var displayUnitPrice = line.originalPrice != null ? line.originalPrice : line.price;
    return h("article", { className: props.newest ? "cart-line cart-line-newest" : "cart-line" },
      h("strong", { className: "cart-name" }, h("span", { className: "cart-index" }, (props.index + 1) + "."), line.name, h("span", { className: "cart-name-price" }, won(displayUnitPrice))),
      h("span", { className: "cart-price" }, won(displayUnitPrice)),
      h("div", { className: "quick-qty" },
        h("button", { onClick: function () { quickQuantity(5); } }, "5+"),
        h("button", { onClick: function () { quickQuantity(10); } }, "10+"),
        h("button", { onClick: function () { quickQuantity(30); } }, "30+"),
        h("button", { onClick: function () { quickQuantity(50); } }, "50+")
      ),
      h("button", { className: "remove-line", title: "삭제", onClick: function () { props.updateLine(line.id, { quantity: 0 }); } }, h(Icon, { name: "trash" })),
      h("div", { className: "qty-controls" },
        h("button", { title: "수량 감소", onClick: function () { props.updateLine(line.id, { quantity: line.quantity - 1 }); } }, h(Icon, { name: "minus" })),
        h("label", { className: "qty-manual" },
          h("span", null, "수량"),
          h("input", {
            value: quantityText,
            inputMode: "numeric",
            pattern: "[0-9]*",
            "aria-label": line.name + " 수량 직접 입력",
            onFocus: function (event) { event.target.select(); },
            onChange: function (event) { setQuantityText(String(event.target.value || "").replace(/[^\d]/g, "").slice(0, 3)); },
            onBlur: commitQuantity,
            onKeyDown: function (event) {
              if (event.key === "Enter") {
                event.preventDefault();
                commitQuantity();
                event.currentTarget.blur();
              }
            }
          })
        ),
        h("button", { title: "수량 증가", onClick: function () { props.updateLine(line.id, { quantity: line.quantity + 1 }); } }, h(Icon, { name: "plus" }))
      ),
      h("b", { className: "cart-line-total" }, won(line.price * line.quantity))
    );
  }

  function Totals(props) {
    return h("dl", { className: "totals" },
      row("상품 합계", won(props.total.subtotal)),
      row("할인", "-" + won(props.total.discount)),
      row("총금액", won(props.total.total)),
      h("div", { className: "vat-toggle-row" }, h("dt", null, "VAT"), h("dd", null, h("label", { className: props.vatBlocked ? "vat-check disabled" : "vat-check" }, h("input", { type: "checkbox", checked: props.vatChecked && !props.vatBlocked, disabled: props.vatBlocked, onChange: function (e) { if (!props.vatBlocked) props.setVatChecked(e.target.checked); } }), h("span", { className: "vat-amount" }, props.vatBlocked ? "VAT 없음" : won(props.total.vat))))),
      h("div", { className: "grand" }, h("dt", null, "총"), h("dd", null, (props.totalQuantity || 0) + "개"))
    );
  }

  function row(label, value) {
    return h("div", null, h("dt", null, label), h("dd", null, value));
  }

  function ManageScreen(props) {
    var state = props.state, setState = props.setState;
    var activeListHook = React.useState("categories");
    var activeList = activeListHook[0], setActiveList = activeListHook[1];
    var activeFormHook = React.useState(null);
    var activeForm = activeFormHook[0], setActiveForm = activeFormHook[1];
    var itemCategoryHook = React.useState("");
    var itemCategoryId = itemCategoryHook[0], setItemCategoryId = itemCategoryHook[1];
    var editingHook = React.useState(null);
    var editing = editingHook[0], setEditing = editingHook[1];
    var backupInputRef = React.useRef(null);
    var categories = state.categories || [];
    var items = state.items || [];
    var customers = state.customers || [];
    var writers = state.writers || [];
    var groups = state.groups || [];
    var categoryNameById = {};
    categories.forEach(function (category) { categoryNameById[category.id] = category.name; });
    var groupRows = groups.slice().sort(function (a, b) {
      if (a.categoryId !== b.categoryId) return (categoryNameById[a.categoryId] || "").localeCompare(categoryNameById[b.categoryId] || "", "ko-KR");
      return (a.sort || 0) - (b.sort || 0);
    }).map(function (group) {
      var count = items.filter(function (item) { return item.categoryId === group.categoryId && item.groupName === group.name; }).length;
      return { id: group.id, name: group.name, meta: (categoryNameById[group.categoryId] || "카테고리 없음") + " · " + count + "개" };
    });
    function selectList(key) {
      setActiveList(key);
      setEditing(null);
    }
    React.useEffect(function () {
      return registerMobileBackHandler(function () {
        if (editing) {
          setEditing(null);
          return true;
        }
        if (activeForm) {
          setActiveForm(null);
          return true;
        }
        if (activeList !== "categories") {
          setActiveList("categories");
          return true;
        }
        return false;
      });
    }, [editing, activeForm, activeList]);
    function openEditor(type, idValue) {
      var target = type === "categories" ? categories.find(function (entry) { return entry.id === idValue; }) : type === "groups" ? groups.find(function (entry) { return entry.id === idValue; }) : type === "items" ? items.find(function (entry) { return entry.id === idValue; }) : type === "customers" ? customers.find(function (entry) { return entry.id === idValue; }) : type === "writers" ? writers.find(function (entry) { return entry.id === idValue; }) : null;
      if (!target) return;
      setEditing({ type: type, id: idValue, draft: clone(target) });
    }
    function saveEditor() {
      if (!editing) return;
      var draft = Object.assign({}, editing.draft);
      draft.name = safeText(draft.name);
      if (!draft.name) return;
      if (editing.type === "categories") {
        setState(function (current) { return Object.assign({}, current, { categories: (current.categories || []).map(function (category) { return category.id === editing.id ? Object.assign({}, category, { name: draft.name }) : category; }) }); });
      }
      if (editing.type === "groups") {
        var original = groups.find(function (group) { return group.id === editing.id; });
        setState(function (current) { return Object.assign({}, current, {
          groups: (current.groups || []).map(function (group) { return group.id === editing.id ? Object.assign({}, group, { name: draft.name, categoryId: draft.categoryId }) : group; }),
          items: (current.items || []).map(function (item) {
            if (original && item.categoryId === original.categoryId && item.groupName === original.name) return Object.assign({}, item, { categoryId: draft.categoryId, groupName: draft.name });
            return item;
          })
        }); });
      }
      if (editing.type === "items") {
        setState(function (current) { return Object.assign({}, current, { items: (current.items || []).map(function (item) { return item.id === editing.id ? Object.assign({}, item, { name: draft.name, categoryId: draft.categoryId, groupName: safeText(draft.groupName || ""), price: clamp(draft.price, 0, MAX_PRICE) }) : item; }) }); });
      }
      if (editing.type === "customers") {
        var customerRules = customerRulesFromNote(draft.note || "");
        setState(function (current) { return Object.assign({}, current, { customers: (current.customers || []).map(function (customer) { return customer.id === editing.id ? Object.assign({}, customer, { name: draft.name, discountRate: clamp(draft.discountRate, 0, 100), note: safeText(draft.note || ""), pricingRules: customerRules.pricingRules, discountRules: customerRules.discountRules }) : customer; }) }); });
      }
      if (editing.type === "writers") {
        setState(function (current) { return Object.assign({}, current, { writers: (current.writers || []).map(function (writer) { return writer.id === editing.id ? Object.assign({}, writer, { name: draft.name }) : writer; }) }); });
      }
      setEditing(null);
    }
    function deleteCategory(categoryId) {
      if (!window.confirm("카테고리를 삭제하면 해당 품목도 같이 삭제됩니다. 삭제할까요?")) return;
      setState(function (current) { return Object.assign({}, current, {
        categories: (current.categories || []).filter(function (category) { return category.id !== categoryId; }),
        groups: (current.groups || []).filter(function (group) { return group.categoryId !== categoryId; }),
        items: (current.items || []).filter(function (item) { return item.categoryId !== categoryId; })
      }); });
    }
    function deleteGroup(groupId) {
      var group = groups.find(function (entry) { return entry.id === groupId; });
      if (!group) return;
      if (!window.confirm(group.name + " 세부 카테고리와 그 안의 품목을 삭제할까요?")) return;
      setState(function (current) { return Object.assign({}, current, {
        groups: (current.groups || []).filter(function (entry) { return entry.id !== groupId; }),
        items: (current.items || []).filter(function (item) { return !(item.categoryId === group.categoryId && item.groupName === group.name); })
      }); });
    }
    function deleteItem(itemId) {
      var target = items.find(function (item) { return item.id === itemId; });
      if (!target) return;
      if (!window.confirm((target.groupName ? target.groupName + " · " : "") + target.name + " " + won(target.price) + " 품목을 삭제할까요?")) return;
      setState(function (current) { return Object.assign({}, current, { items: (current.items || []).filter(function (item) { return item.id !== itemId; }) }); });
    }
    function deleteItems(itemIds) {
      if (!itemIds.length) return false;
      if (!window.confirm("선택한 품목 " + itemIds.length + "개를 삭제할까요?")) return false;
      setState(function (current) { return Object.assign({}, current, { items: (current.items || []).filter(function (item) { return itemIds.indexOf(item.id) < 0; }) }); });
      return true;
    }
    function deleteCustomer(customerId) {
      var target = customers.find(function (customer) { return customer.id === customerId; });
      if (!target) return;
      if (target.id === "customer_walkin") {
        alert("일반 거래처는 기본값이라 삭제할 수 없습니다.");
        return;
      }
      if (customers.filter(function (customer) { return customer.active !== false; }).length <= 1) {
        alert("거래처는 최소 1개가 필요합니다.");
        return;
      }
      if (!window.confirm(target.name + " 거래처를 삭제할까요? 기존 내역과 영수증 기록은 유지됩니다.")) return;
      setState(function (current) {
        return Object.assign({}, current, { customers: (current.customers || []).filter(function (customer) { return customer.id !== customerId; }) });
      });
      if (editing && editing.type === "customers" && editing.id === customerId) setEditing(null);
    }
    function moveCategory(categoryId, direction) {
      setState(function (current) {
        var categories = (current.categories || []).slice().sort(function (a, b) { return a.sort - b.sort; });
        var index = categories.findIndex(function (category) { return category.id === categoryId; });
        var nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= categories.length) return current;
        var moving = categories[index];
        categories[index] = categories[nextIndex];
        categories[nextIndex] = moving;
        return Object.assign({}, current, { categories: categories.map(function (category, categoryIndex) { return Object.assign({}, category, { sort: categoryIndex + 1 }); }) });
      });
    }
    function exportBackup() {
      var payload = {
        app: "pors-piercing-pos",
        exportedAt: new Date().toISOString(),
        dataVersion: DATA_VERSION,
        state: clone(state)
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "pors-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    function importBackupFile(event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result || "{}"));
          var importedState = parsed.state || parsed;
          if (!Array.isArray(importedState.items) || !Array.isArray(importedState.customers)) throw new Error("invalid backup");
          if (!window.confirm("백업 파일의 데이터로 현재 데이터를 복구할까요? Firebase에도 다시 저장됩니다.")) return;
          setState(normalizeState(Object.assign(clone(seed), importedState)));
          alert("백업 파일을 불러왔습니다.");
        } catch (error) {
          alert("백업 파일 형식이 올바르지 않습니다.");
        }
      };
      reader.readAsText(file);
    }
    function reloadFromFirebase() {
      if (!window.confirm("Firebase에 저장된 최신 데이터로 다시 불러올까요? 현재 기기의 임시 변경은 덮어써질 수 있습니다.")) return;
      pullCloudState().then(function (cloudState) {
        if (!cloudState) {
          alert("Firebase에서 불러올 데이터가 없습니다.");
          return;
        }
        setState(normalizeState(Object.assign(clone(seed), cloudState)));
        alert("Firebase 데이터를 다시 불러왔습니다.");
      }).catch(function () {
        alert("Firebase 데이터를 불러오지 못했습니다.");
      });
    }
    var itemFilterCategoryId = itemCategoryId || (categories[0] && categories[0].id) || "";
    var itemRows = items.filter(function (item) {
      return !itemFilterCategoryId || item.categoryId === itemFilterCategoryId;
    }).map(function (i) {
      return { id: i.id, categoryId: i.categoryId, name: (i.groupName ? i.groupName + " · " : "") + i.name, meta: won(i.price) };
    });
    var adminSections = [
      { key: "categories", listKind: "categories", title: "카테고리", rows: categories.slice().sort(function (a, b) { return a.sort - b.sort; }).map(function (c) { return { id: c.id, name: c.name, meta: c.discountableDefault === false ? "할인 불가" : "" }; }), onEdit: function (idValue) { openEditor("categories", idValue); }, onDelete: deleteCategory, onMove: moveCategory },
      { key: "groups", listKind: "groups", title: "세부 카테고리", rows: groupRows, onEdit: function (idValue) { openEditor("groups", idValue); }, onDelete: deleteGroup },
      { key: "items", listKind: "items", title: "품목", rows: itemRows, categories: categories.slice().sort(function (a, b) { return a.sort - b.sort; }), activeCategoryId: itemFilterCategoryId, setActiveCategoryId: setItemCategoryId, onEdit: function (idValue) { openEditor("items", idValue); }, onDelete: deleteItem, onBulkDelete: deleteItems },
      { key: "customers", listKind: "customers", title: "거래처", rows: customers.map(function (c) { return { id: c.id, name: c.name, meta: c.discountRate + "%", note: customerRuleSummary(c) }; }), onEdit: function (idValue) { openEditor("customers", idValue); }, onDelete: deleteCustomer },
      { key: "writers", listKind: "writers", title: "작성자", rows: writers.map(function (writer) { return { id: writer.id, name: writer.name, meta: writer.id === "writer_default" ? "기본값" : "" }; }), onEdit: function (idValue) { openEditor("writers", idValue); } }
    ];
    var selectedSection = adminSections.find(function (section) { return section.key === activeList; }) || adminSections[0];
    var formSections = [
      { key: "category", label: "카테고리", title: "카테고리 추가", form: h(CategoryForm, { setState: setState }) },
      { key: "group", label: "세부", title: "세부 카테고리 추가", form: h(GroupForm, { state: state, setState: setState }) },
      { key: "item", label: "품목", title: "품목 추가", form: h(ItemForm, { state: state, setState: setState }) },
      { key: "customer", label: "거래처", title: "거래처 추가", form: h(CustomerForm, { setState: setState }) },
      { key: "writer", label: "작성자", title: "작성자 추가", form: h(WriterForm, { setState: setState }) }
    ];
    var selectedForm = formSections.find(function (section) { return section.key === activeForm; });
    return h("main", { className: "manage-page" },
      h("section", { className: "backup-panel" },
        h("div", null,
          h("strong", null, "데이터 백업/복구"),
          h("span", null, "품목, 거래처, 작성자, 내역을 파일로 보관하거나 Firebase에서 다시 불러옵니다.")
        ),
        h("div", { className: "backup-actions" },
          h("button", { className: "ghost", type: "button", onClick: exportBackup }, "데이터 백업"),
          h("button", { className: "ghost", type: "button", onClick: function () { if (backupInputRef.current) backupInputRef.current.click(); } }, "백업 파일 불러오기"),
          h("button", { className: "ghost", type: "button", onClick: reloadFromFirebase }, "Firebase 다시 불러오기"),
          h("input", { ref: backupInputRef, className: "backup-file-input", type: "file", accept: "application/json,.json", onChange: importBackupFile })
        )
      ),
      h("section", { className: "quick-add-panel" },
        h("div", { className: "quick-add-grid" }, formSections.map(function (section) {
          return h("button", {
            key: section.key,
            className: activeForm === section.key ? "quick-add active" : "quick-add",
            onClick: function () { setActiveForm(activeForm === section.key ? null : section.key); }
          }, h("span", null, "+"), h("b", null, section.label));
        })),
        selectedForm ? h("div", { key: selectedForm.key, className: "quick-form-card" },
          h("div", { className: "quick-form-head" },
            h("strong", null, selectedForm.title),
            h("button", { className: "ghost small", onClick: function () { setActiveForm(null); } }, "닫기")
          ),
          selectedForm.form
        ) : null
      ),
      h("section", { className: "wide-panel" }, h("h2", null, "등록 목록"),
        h("div", { className: "admin-tabs" }, adminSections.map(function (section) { return h("button", { key: section.key, className: activeList === section.key ? "active" : "", onClick: function () { selectList(section.key); } }, section.title + " " + section.rows.length); })),
        h("div", { className: editing ? "admin-workspace editing" : "admin-workspace" },
          h("div", { key: selectedSection.key, className: "admin-list-single" }, h(AdminList, selectedSection)),
          editing ? h(EditPanel, { key: editing.type + "-" + editing.id, editing: editing, setEditing: setEditing, saveEditor: saveEditor, categories: categories, groups: groups }) : h("aside", { className: "edit-placeholder" }, h("strong", null, "수정할 항목을 선택하세요"), h("span", null, "목록에서 수정 버튼을 누르면 여기에서 바로 편집할 수 있습니다."))
        )
      )
    );
  }

  function EditPanel(props) {
    var editing = props.editing;
    var draft = editing.draft;
    var setEditing = props.setEditing;
    var categories = props.categories || [];
    var groups = props.groups || [];
    var categoryGroups = groups.filter(function (group) { return group.categoryId === draft.categoryId; });
    function patchDraft(patch) {
      setEditing(Object.assign({}, editing, { draft: Object.assign({}, draft, patch) }));
    }
    return h("aside", { className: "edit-panel" },
      h("div", { className: "edit-panel-head" },
        h("div", null, h("strong", null, "빠른 수정"), h("span", null, editing.type === "categories" ? "카테고리" : editing.type === "groups" ? "세부 카테고리" : editing.type === "items" ? "품목" : editing.type === "customers" ? "거래처" : "작성자")),
        h("button", { className: "ghost small", onClick: function () { setEditing(null); } }, "닫기")
      ),
      (editing.type === "groups" || editing.type === "items") ? h("label", null, "카테고리", h("select", { value: draft.categoryId || "", onChange: function (event) { patchDraft({ categoryId: event.target.value, groupName: "" }); } }, categories.map(function (category) { return h("option", { key: category.id, value: category.id }, category.name); }))) : null,
      editing.type === "items" ? h("label", null, "세부 카테고리", h("select", { value: draft.groupName || "", onChange: function (event) { patchDraft({ groupName: event.target.value }); } }, h("option", { value: "" }, categoryGroups.length ? "선택 안함" : "세부 카테고리 없음"), categoryGroups.map(function (group) { return h("option", { key: group.id, value: group.name }, group.name); }))) : null,
      h("label", null, editing.type === "items" ? "품목명" : "이름", h("input", { value: draft.name || "", onChange: function (event) { patchDraft({ name: event.target.value }); } })),
      editing.type === "items" ? h("label", null, "단가", h("input", { value: draft.price || "", inputMode: "numeric", onChange: function (event) { patchDraft({ price: event.target.value }); } })) : null,
      editing.type === "customers" ? h("label", null, "할인율 %", h("input", { value: draft.discountRate || "", inputMode: "decimal", onChange: function (event) { patchDraft({ discountRate: event.target.value }); } })) : null,
      editing.type === "customers" ? h("label", null, "기타사항", h("textarea", { value: draft.note || "", onChange: function (event) { patchDraft({ note: event.target.value }); }, placeholder: "예: 니들 10,000원 / 점토 할인X" })) : null,
      editing.type === "customers" && customerRuleSummary(draft) ? h("small", { className: "customer-note" }, customerRuleSummary(Object.assign({}, draft, customerRulesFromNote(draft.note || "")))) : null,
      h("button", { className: "primary", onClick: props.saveEditor }, "수정 저장")
    );
  }

  function FormCard(props) {
    return h("details", { className: "management-card compact-form", open: props.open }, h("summary", null, props.title), props.children);
  }

  function CategoryForm(props) {
    var nameHook = React.useState("");
    var name = nameHook[0], setName = nameHook[1];
    return h("form", { className: "stack-form", onSubmit: function (e) {
      e.preventDefault();
      var cleanName = safeText(name);
      if (!cleanName) return;
      props.setState(function (s) { return Object.assign({}, s, { categories: s.categories.concat([{ id: id("cat"), name: cleanName, sort: Date.now(), discountableDefault: cleanName === "할인 안됨" || cleanName === "할인 X" ? false : true, active: true }]) }); });
      setName("");
    } }, h("input", { value: name, onChange: function (e) { setName(e.target.value); }, placeholder: "예: 큐빅" }), h("button", { className: "primary" }, "카테고리 저장"));
  }

  function GroupForm(props) {
    var categories = props.state.categories || [];
    var defaultCategoryId = categories[0] ? categories[0].id : "";
    var formHook = React.useState({ categoryId: defaultCategoryId, name: "" });
    var form = formHook[0], setForm = formHook[1];
    return h("form", { className: "stack-form", onSubmit: function (e) {
      e.preventDefault();
      var cleanName = safeText(form.name);
      if (!form.categoryId || !cleanName) return;
      props.setState(function (s) {
        var groups = s.groups || [];
        var exists = groups.some(function (group) { return group.categoryId === form.categoryId && group.name === cleanName; });
        if (exists) return s;
        return Object.assign({}, s, { groups: groups.concat([{ id: id("group"), categoryId: form.categoryId, name: cleanName, sort: Date.now(), active: true }]) });
      });
      setForm(Object.assign({}, form, { name: "" }));
    } },
      h("select", { value: form.categoryId, onChange: function (e) { setForm(Object.assign({}, form, { categoryId: e.target.value })); } }, categories.map(function (category) { return h("option", { key: category.id, value: category.id }, category.name); })),
      h("input", { value: form.name, onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })); }, placeholder: "예: 스톤ㆍ큐빅" }),
      h("button", { className: "primary" }, "세부 카테고리 저장")
    );
  }

  function ItemForm(props) {
    var categories = props.state.categories || [];
    var groups = props.state.groups || [];
    var defaultCategoryId = categories[0] ? categories[0].id : "";
    var formHook = React.useState({ name: "", groupName: "", price: "", categoryId: defaultCategoryId });
    var form = formHook[0], setForm = formHook[1];
    var categoryGroups = groups.filter(function (group) { return group.active !== false && group.categoryId === form.categoryId; }).sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    return h("form", { className: "stack-form", onSubmit: function (e) {
      e.preventDefault();
      var cleanName = safeText(form.name);
      var cleanGroupName = safeText(form.groupName);
      if (!form.categoryId || !cleanName) return;
      if (categoryGroups.length && !cleanGroupName) return;
      props.setState(function (s) {
        return Object.assign({}, s, { items: (s.items || []).concat([Object.assign({}, form, {
          id: id("item"),
          name: cleanName,
          groupName: cleanGroupName,
          price: clamp(form.price, 0, MAX_PRICE),
          discountable: itemDiscountable(form.categoryId, s.categories || []),
          active: true,
          sort: Date.now()
        })]) });
      });
      setForm(Object.assign({}, form, { name: "", price: "" }));
    } },
      h("div", { className: "form-split" },
        h("select", { value: form.categoryId, onChange: function (e) { setForm(Object.assign({}, form, { categoryId: e.target.value, groupName: "" })); } }, categories.map(function (category) { return h("option", { key: category.id, value: category.id }, category.name); })),
        h("select", { value: form.groupName, onChange: function (e) { setForm(Object.assign({}, form, { groupName: e.target.value })); } },
          h("option", { value: "" }, categoryGroups.length ? "세부 카테고리 선택" : "세부 카테고리 없음"),
          categoryGroups.map(function (group) { return h("option", { key: group.id, value: group.name }, group.name); })
        )
      ),
      h("input", { value: form.name, onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })); }, placeholder: "품목명" }),
      h("input", { value: form.price, inputMode: "numeric", onChange: function (e) { setForm(Object.assign({}, form, { price: e.target.value })); }, placeholder: "단가" }),
      h("button", { className: "primary" }, "품목 저장")
    );
  }

  function CustomerForm(props) {
    var formHook = React.useState({ name: "", discountRate: "", note: "" });
    var form = formHook[0], setForm = formHook[1];
    return h("form", { className: "stack-form customer-form", onSubmit: function (e) {
      e.preventDefault();
      var cleanName = safeText(form.name);
      if (!cleanName) return;
      var rules = customerRulesFromNote(form.note);
      props.setState(function (s) { return Object.assign({}, s, { customers: s.customers.concat([{ id: id("customer"), name: cleanName, discountRate: clamp(form.discountRate, 0, 100), vatEnabled: false, active: true, note: safeText(form.note), pricingRules: rules.pricingRules, discountRules: rules.discountRules }]) }); });
      setForm({ name: "", discountRate: "", note: "" });
    } }, h("div", { className: "form-split" }, h("input", { value: form.name, onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })); }, placeholder: "거래처명" }), h("input", { value: form.discountRate, inputMode: "decimal", onChange: function (e) { setForm(Object.assign({}, form, { discountRate: e.target.value })); }, placeholder: "할인율 %" })), h("textarea", { value: form.note, onChange: function (e) { setForm(Object.assign({}, form, { note: e.target.value })); }, placeholder: "기타사항 (예: 니들 10,000원 / 점토 할인X)" }), h("button", { className: "primary" }, "거래처 저장"));
  }

  function WriterForm(props) {
    var nameHook = React.useState("");
    var name = nameHook[0], setName = nameHook[1];
    return h("form", { className: "stack-form", onSubmit: function (e) {
      e.preventDefault();
      var cleanName = safeText(name);
      if (!cleanName) return;
      props.setState(function (s) {
        var writers = s.writers || [];
        var exists = writers.some(function (writer) { return writer.name === cleanName; });
        if (exists) return s;
        return Object.assign({}, s, { writers: writers.concat([{ id: id("writer"), name: cleanName, active: true }]) });
      });
      setName("");
    } }, h("input", { value: name, onChange: function (e) { setName(e.target.value); }, placeholder: "작성자명" }), h("button", { className: "primary" }, "작성자 저장"));
  }

  function AdminList(props) {
    var selectedHook = React.useState([]);
    var selected = selectedHook[0], setSelected = selectedHook[1];
    function toggle(rowId, checked) {
      setSelected(function (current) {
        return checked ? current.concat([rowId]).filter(function (idValue, index, array) { return array.indexOf(idValue) === index; }) : current.filter(function (idValue) { return idValue !== rowId; });
      });
    }
    function clearSelection() {
      setSelected([]);
    }
    function bulkDelete() {
      if (props.onBulkDelete(selected) !== false) clearSelection();
    }
    return h("div", { className: "admin-list " + (props.listKind || "") },
      h("div", { className: "admin-list-head" },
        h("h3", null, props.title),
        h("small", { className: "list-count" }, (props.rows || []).length + "개"),
        props.onBulkDelete ? h("button", { className: "delete-row", disabled: !selected.length, onClick: bulkDelete }, "선택 삭제 " + selected.length) : null
      ),
      props.listKind === "items" ? h("div", { className: "admin-category-tabs" }, (props.categories || []).map(function (category) {
        return h("button", {
          key: category.id,
          className: props.activeCategoryId === category.id ? "active" : "",
          onClick: function () {
            clearSelection();
            props.setActiveCategoryId(category.id);
          }
        }, category.name);
      })) : null,
      props.listKind === "items" && (props.rows || []).length ? h("div", { className: "admin-item-grid" }, (props.rows || []).map(function (r) {
        return h("article", { key: r.id, className: selected.indexOf(r.id) >= 0 ? "admin-item-card selected" : "admin-item-card" },
          props.onBulkDelete ? h("input", { className: "admin-check", type: "checkbox", checked: selected.indexOf(r.id) >= 0, onChange: function (event) { toggle(r.id, event.target.checked); } }) : null,
          h("span", { className: "admin-item-name" }, r.name),
          h("strong", null, r.meta),
          h("div", { className: "admin-item-actions" },
            props.onEdit ? h("button", { className: "edit-row", onClick: function () { props.onEdit(r.id); } }, "수정") : null,
            props.onDelete ? h("button", { className: "delete-row", onClick: function () { props.onDelete(r.id); } }, "삭제") : null
          )
        );
      })) : (props.rows || []).length ? (props.rows || []).map(function (r) {
      return h("div", { key: r.id, className: props.onBulkDelete ? "admin-row selectable" : "admin-row" },
        props.onBulkDelete ? h("input", { className: "admin-check", type: "checkbox", checked: selected.indexOf(r.id) >= 0, onChange: function (event) { toggle(r.id, event.target.checked); } }) : null,
        h("span", null, r.name, r.note ? h("small", { className: "admin-row-note" }, r.note) : null),
        h("b", null, r.meta),
        props.onMove ? h("button", { className: "edit-row move-row", onClick: function () { props.onMove(r.id, -1); } }, "↑") : null,
        props.onMove ? h("button", { className: "edit-row move-row", onClick: function () { props.onMove(r.id, 1); } }, "↓") : null,
        props.onEdit ? h("button", { className: "edit-row", onClick: function () { props.onEdit(r.id); } }, "수정") : null,
        props.onDelete ? h("button", { className: "delete-row", onClick: function () { props.onDelete(r.id); } }, "삭제") : null
      );
    }) : h("p", { className: "admin-empty" }, "등록된 항목이 없습니다."));
  }

  function HistoryScreen(props) {
    var queryHook = React.useState("");
    var query = queryHook[0], setQuery = queryHook[1];
    var historyPeriodHook = React.useState("today");
    var historyPeriod = historyPeriodHook[0], setHistoryPeriod = historyPeriodHook[1];
    var customRangeHook = React.useState(function () {
      var today = inputDateValue(new Date());
      return { from: today, to: today };
    });
    var customRange = customRangeHook[0], setCustomRange = customRangeHook[1];
    var calendarOpenHook = React.useState(false);
    var calendarOpen = calendarOpenHook[0], setCalendarOpen = calendarOpenHook[1];
    var calendarMonthHook = React.useState(function () {
      var today = new Date();
      return new Date(today.getFullYear(), today.getMonth(), 1);
    });
    var calendarMonth = calendarMonthHook[0], setCalendarMonth = calendarMonthHook[1];
    var settleHook = React.useState(false);
    var showSettlement = settleHook[0], setShowSettlement = settleHook[1];
    var periodHook = React.useState("month");
    var settlementPeriod = periodHook[0], setSettlementPeriod = periodHook[1];
    var vatFilterHook = React.useState("all");
    var settlementVatFilter = vatFilterHook[0], setSettlementVatFilter = vatFilterHook[1];
    var editHook = React.useState(null);
    var editingSale = editHook[0], setEditingSale = editHook[1];
    var auditHook = React.useState(null);
    var auditSale = auditHook[0], setAuditSale = auditHook[1];
    var deletionHook = React.useState(false);
    var deletionLogOpen = deletionHook[0], setDeletionLogOpen = deletionHook[1];
    var deleteTargetHook = React.useState(null);
    var deleteTarget = deleteTargetHook[0], setDeleteTarget = deleteTargetHook[1];
    var deleteReasonHook = React.useState("");
    var deleteReason = deleteReasonHook[0], setDeleteReason = deleteReasonHook[1];
    React.useEffect(function () {
      if (!editingSale && !auditSale && !deletionLogOpen && !deleteTarget) return undefined;
      return registerMobileBackHandler(function () {
        if (editingSale) setEditingSale(null);
        else if (deleteTarget) setDeleteTarget(null);
        else if (deletionLogOpen) setDeletionLogOpen(false);
        else setAuditSale(null);
        return true;
      });
    }, [editingSale, auditSale, deletionLogOpen, deleteTarget]);
    function openSaleEditor(sale) {
      setEditingSale({
        original: sale,
        customerName: sale.customerName || "",
        writerName: sale.writerName || "",
        vatEnabled: !!sale.vatEnabled,
        lines: clone(sale.lines || [])
      });
    }
    function updateDraftLine(lineId, field, value) {
      setEditingSale(function (current) {
        return Object.assign({}, current, {
          lines: current.lines.map(function (line) {
            if (line.id !== lineId) return line;
            var patch = {};
            patch[field] = field === "price" ? clamp(value, 0, MAX_PRICE) : clamp(value, 1, MAX_QUANTITY);
            return Object.assign({}, line, patch);
          })
        });
      });
    }
    function removeDraftLine(lineId) {
      setEditingSale(function (current) {
        return Object.assign({}, current, { lines: current.lines.filter(function (line) { return line.id !== lineId; }) });
      });
    }
    function saveSaleEdit() {
      if (!editingSale || !editingSale.lines.length) {
        alert("품목은 한 개 이상 남겨 주세요.");
        return;
      }
      var original = editingSale.original;
      var changes = [];
      if (safeText(original.customerName) !== safeText(editingSale.customerName)) changes.push("거래처: " + (original.customerName || "-") + " → " + (editingSale.customerName || "-"));
      if (safeText(original.writerName) !== safeText(editingSale.writerName)) changes.push("작성자: " + (original.writerName || "-") + " → " + (editingSale.writerName || "-"));
      if (!!original.vatEnabled !== !!editingSale.vatEnabled) changes.push("VAT: " + (original.vatEnabled ? "적용" : "미적용") + " → " + (editingSale.vatEnabled ? "적용" : "미적용"));
      (original.lines || []).forEach(function (line) {
        var nextLine = editingSale.lines.find(function (entry) { return entry.id === line.id; });
        if (!nextLine) {
          changes.push("품목 삭제: " + line.name + " " + line.quantity + "개");
          return;
        }
        if (num(line.quantity) !== num(nextLine.quantity)) changes.push(line.name + " 수량: " + line.quantity + " → " + nextLine.quantity);
        if (num(line.price) !== num(nextLine.price)) changes.push(line.name + " 단가: " + won(line.price) + " → " + won(nextLine.price));
      });
      if (!changes.length) {
        alert("변경된 내용이 없습니다.");
        return;
      }
      props.updateSale(original.id, {
        customerName: safeText(editingSale.customerName) || original.customerName,
        writerName: safeText(editingSale.writerName) || original.writerName,
        vatEnabled: !!editingSale.vatEnabled,
        lines: editingSale.lines
      }, changes);
      setEditingSale(null);
    }
    function requestDeleteSale(sale) {
      setDeleteTarget(sale);
      setDeleteReason("");
    }
    function confirmDeleteSale(event) {
      event.preventDefault();
      if (!deleteTarget) return;
      props.deleteSale(deleteTarget, deleteReason);
      setDeleteTarget(null);
      setDeleteReason("");
    }
    var sortedSales = (props.sales || []).slice().sort(function (a, b) {
      var aTime = Date.parse(a.createdAt || "");
      var bTime = Date.parse(b.createdAt || "");
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    });
    function inputDateValue(date) {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
      return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    }
    function parseInputDate(value) {
      if (!value) return null;
      var date = new Date(value + "T00:00:00");
      return Number.isNaN(date.getTime()) ? null : date;
    }
    function displayInputDate(value) {
      var date = parseInputDate(value);
      if (!date) return "-";
      return String(date.getFullYear()).slice(2) + "." + String(date.getMonth() + 1).padStart(2, "0") + "." + String(date.getDate()).padStart(2, "0");
    }
    function periodRange(period) {
      var now = new Date();
      var start = startOfDay(now);
      var end = endOfDay(now);
      if (period === "week") {
        var day = now.getDay() || 7;
        start = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1));
        end = endOfDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6));
      } else if (period === "month") {
        start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        end = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      }
      return { from: inputDateValue(start), to: inputDateValue(end) };
    }
    function selectHistoryPeriod(period) {
      var range = periodRange(period);
      setHistoryPeriod(period);
      setCustomRange(range);
      var start = parseInputDate(range.from) || new Date();
      setCalendarMonth(new Date(start.getFullYear(), start.getMonth(), 1));
      setCalendarOpen(false);
    }
    function startOfDay(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    }
    function endOfDay(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    }
    function saleDateInRange(sale) {
      var date = new Date(sale.createdAt);
      if (Number.isNaN(date.getTime())) return false;
      var now = new Date();
      var start = customRange.from ? startOfDay(new Date(customRange.from + "T00:00:00")) : new Date(0);
      var end = customRange.to ? endOfDay(new Date(customRange.to + "T00:00:00")) : endOfDay(now);
      return date >= start && date <= end;
    }
    function calendarCells() {
      var first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
      var lastDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
      var cells = [];
      for (var blank = 0; blank < first.getDay(); blank += 1) cells.push("");
      for (var day = 1; day <= lastDate; day += 1) cells.push(inputDateValue(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day)));
      while (cells.length % 7) cells.push("");
      return cells;
    }
    function isDateInSelectedRange(value) {
      var date = parseInputDate(value);
      var from = parseInputDate(customRange.from);
      var to = parseInputDate(customRange.to || customRange.from);
      if (!date || !from || !to) return false;
      return date >= from && date <= to;
    }
    function pickCalendarDate(value) {
      if (!value) return;
      setHistoryPeriod("range");
      if (!customRange.from || customRange.to) {
        setCustomRange({ from: value, to: "" });
        return;
      }
      var start = parseInputDate(customRange.from);
      var end = parseInputDate(value);
      if (end && start && end < start) setCustomRange({ from: value, to: customRange.from });
      else setCustomRange({ from: customRange.from, to: value });
      setCalendarOpen(false);
    }
    function moveCalendarMonth(offset) {
      setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1));
    }
    var periodSales = sortedSales.filter(saleDateInRange);
    var filtered = periodSales.filter(function (sale) {
      var lines = sale.lines || [];
      if (!query) return true;
      return sale.customerName.indexOf(query) >= 0 || (sale.customerNote || "").indexOf(query) >= 0 || (sale.writerName || "").indexOf(query) >= 0 || lines.some(function (line) { return line.name.indexOf(query) >= 0; });
    });
    var settlementSales = filtered.filter(function (sale) {
      var vat = num((sale.totals || {}).vat);
      if (settlementVatFilter === "vat") return vat > 0;
      if (settlementVatFilter === "noVat") return vat <= 0;
      if (settlementVatFilter === "offshore") return !!sale.offshoreSettlement;
      return true;
    });
    function shortDate(value) {
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return "-";
      return String(date.getFullYear()).slice(2) + "." + String(date.getMonth() + 1).padStart(2, "0") + "." + String(date.getDate()).padStart(2, "0");
    }
    function weekKey(date) {
      var target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      var day = target.getDay() || 7;
      target.setDate(target.getDate() + 4 - day);
      var yearStart = new Date(target.getFullYear(), 0, 1);
      var week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
      return String(target.getFullYear()).slice(2) + "." + String(week).padStart(2, "0") + "주";
    }
    function periodKey(sale) {
      var date = new Date(sale.createdAt);
      if (Number.isNaN(date.getTime())) return "-";
      if (settlementPeriod === "day") return shortDate(sale.createdAt);
      if (settlementPeriod === "week") return weekKey(date);
      if (settlementPeriod === "all") return "전체";
      return String(date.getFullYear()).slice(2) + "." + String(date.getMonth() + 1).padStart(2, "0");
    }
    function settlementRows() {
      var map = {};
      settlementSales.forEach(function (sale) {
        var key = periodKey(sale) + "||" + (sale.customerName || "-");
        var totalsValue = sale.totals || {};
        if (!map[key]) {
          map[key] = {
            period: periodKey(sale),
            customerName: sale.customerName || "-",
            count: 0,
            quantity: 0,
            subtotal: 0,
            discount: 0,
            supply: 0,
            vat: 0,
            total: 0,
            offshoreJapanAmount: 0,
            offshoreCommission: 0,
            offshoreReceivable: 0,
            offshoreVat: 0
          };
        }
        var offshoreNote = safeText(sale.customerNote || "");
        var legacyTradeMatch = offshoreNote.match(/무역회사\s*(\d+(?:\.\d+)?)%/);
        var offshore = sale.offshoreSettlement || (/무역회사/.test(offshoreNote) ? offshoreSettlementForTotal(totalsValue, { offshore: true, tradeCompanyName: "MBN", tradeCommissionRate: legacyTradeMatch ? legacyTradeMatch[1] : 5 }) : {});
        map[key].count += 1;
        map[key].quantity += (sale.lines || []).reduce(function (sum, line) { return sum + num(line.quantity); }, 0);
        map[key].subtotal += num(totalsValue.subtotal);
        map[key].discount += num(totalsValue.discount);
        map[key].supply += num(totalsValue.supply);
        map[key].vat += num(totalsValue.vat);
        map[key].total += num(totalsValue.total);
        map[key].offshoreJapanAmount += num(offshore.japanAmount);
        map[key].offshoreCommission += num(offshore.commission);
        map[key].offshoreReceivable += num(offshore.receivable);
        map[key].offshoreVat += num(offshore.vat);
      });
      return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
        if (a.period !== b.period) return a.period < b.period ? 1 : -1;
        return a.customerName.localeCompare(b.customerName, "ko-KR");
      });
    }
    var rows = settlementRows();
    var grand = rows.reduce(function (sum, row) {
      return {
        count: sum.count + row.count,
        quantity: sum.quantity + row.quantity,
        subtotal: sum.subtotal + row.subtotal,
        discount: sum.discount + row.discount,
        supply: sum.supply + row.supply,
        vat: sum.vat + row.vat,
        total: sum.total + row.total,
        offshoreJapanAmount: sum.offshoreJapanAmount + row.offshoreJapanAmount,
        offshoreCommission: sum.offshoreCommission + row.offshoreCommission,
        offshoreReceivable: sum.offshoreReceivable + row.offshoreReceivable,
        offshoreVat: sum.offshoreVat + row.offshoreVat
      };
    }, { count: 0, quantity: 0, subtotal: 0, discount: 0, supply: 0, vat: 0, total: 0, offshoreJapanAmount: 0, offshoreCommission: 0, offshoreReceivable: 0, offshoreVat: 0 });
    return h(React.Fragment, null, h("main", { className: "history-panel" },
      h("div", { className: "history-toolbar" },
        h("div", { className: "history-filter-bar" },
          h("div", { className: "history-period-tabs" }, [["today", "오늘"], ["week", "주"], ["month", "월"]].map(function (entry) {
            return h("button", { key: entry[0], className: historyPeriod === entry[0] ? "active" : "", onClick: function () { selectHistoryPeriod(entry[0]); } }, entry[1]);
          })),
          h("div", { className: "history-date-range" },
            h("button", { className: "history-range-button", onClick: function () { setCalendarOpen(!calendarOpen); } },
              h("span", null, "기간"),
              h("strong", null, displayInputDate(customRange.from) + " ~ " + displayInputDate(customRange.to || customRange.from))
            )
          )
        ),
        calendarOpen ? h("div", { className: "history-calendar" },
            h("div", { className: "history-calendar-head" },
              h("button", { onClick: function () { moveCalendarMonth(-1); } }, "‹"),
              h("strong", null, calendarMonth.getFullYear() + "년 " + (calendarMonth.getMonth() + 1) + "월"),
              h("button", { onClick: function () { moveCalendarMonth(1); } }, "›")
            ),
            h("div", { className: "history-calendar-weekdays" }, ["일", "월", "화", "수", "목", "금", "토"].map(function (dayName) {
              return h("span", { key: dayName }, dayName);
            })),
            h("div", { className: "history-calendar-grid" }, calendarCells().map(function (value, index) {
              var isStart = value && value === customRange.from;
              var isEnd = value && value === customRange.to;
              var inRange = value && isDateInSelectedRange(value);
              return h("button", {
                key: value || "blank-" + index,
                className: !value ? "blank" : (isStart ? "start " : "") + (isEnd ? "end " : "") + (inRange ? "in-range" : ""),
                disabled: !value,
                onClick: function () { pickCalendarDate(value); }
              }, value ? String(parseInputDate(value).getDate()) : "");
            })),
            h("div", { className: "history-calendar-help" }, customRange.from && !customRange.to ? "종료일을 선택하세요" : "시작일과 종료일을 선택하세요")
        ) : null,
        h("div", { className: "search-row" }, h("input", { value: query, onChange: function (e) { setQuery(e.target.value); }, placeholder: "날짜, 거래처, 작성자, 품목 검색" })),
        props.settlementAccess ? h("div", { className: "history-admin-tools" },
          h("button", { className: showSettlement ? "settlement-button active" : "settlement-button", onClick: function () { setShowSettlement(!showSettlement); } }, showSettlement ? "내역 보기" : "정산"),
          h("button", { className: "settlement-button delete-log-button", onClick: function () { setDeletionLogOpen(true); } }, "삭제 기록")
        ) : null
      ),
      showSettlement ? h("section", { className: "settlement-panel" },
        h("div", { className: "settlement-head" },
          h("strong", null, "정산표"),
          h("div", { className: "period-tabs" }, [["day", "일별"], ["week", "주별"], ["month", "월별"], ["all", "전체"]].map(function (entry) {
            return h("button", { key: entry[0], className: settlementPeriod === entry[0] ? "active" : "", onClick: function () { setSettlementPeriod(entry[0]); } }, entry[1]);
          })),
          h("div", { className: "period-tabs vat-tabs" }, [["all", "전체"], ["vat", "세금"], ["noVat", "세금X"], ["offshore", "해외"]].map(function (entry) {
            return h("button", { key: entry[0], className: settlementVatFilter === entry[0] ? "active" : "", onClick: function () { setSettlementVatFilter(entry[0]); } }, entry[1]);
          }))
        ),
        h("div", { className: "settlement-summary" },
          h("div", null, h("span", null, "건수"), h("strong", null, grand.count + "건")),
          h("div", null, h("span", null, "수량"), h("strong", null, grand.quantity + "개")),
          h("div", null, h("span", null, "상품합계"), h("strong", null, won(grand.subtotal))),
          h("div", null, h("span", null, "할인"), h("strong", null, "-" + won(grand.discount))),
          h("div", null, h("span", null, "VAT"), h("strong", null, won(grand.vat))),
          h("div", null, h("span", null, "총액"), h("strong", null, won(grand.total)))
        ),
        h("div", { className: "settlement-table" },
          h("div", { className: "settlement-table-head" }, h("span", null, "기간"), h("span", null, "거래처"), h("span", null, "건수"), h("span", null, "수량"), h("span", null, "상품합계"), h("span", null, "할인"), h("span", null, "공급가"), h("span", null, "VAT"), h("span", null, "총액")),
          rows.length ? rows.map(function (row) {
            return h("div", { className: "settlement-row", key: row.period + row.customerName },
              h("span", null, row.period),
              h("strong", null, row.customerName),
              h("span", null, row.count + "건"),
              h("span", null, row.quantity + "개"),
              h("span", null, won(row.subtotal)),
              h("span", null, "-" + won(row.discount)),
              h("span", null, won(row.supply)),
              h("span", null, won(row.vat)),
              h("b", null, won(row.total))
            );
          }) : h("p", { className: "empty" }, "정산할 내역이 없습니다.")
        )
      ) : h("div", { className: "history-list" }, filtered.length ? filtered.map(function (sale) {
        var lines = sale.lines || [];
        var itemCount = lines.length;
        var quantityCount = lines.reduce(function (sum, line) { return sum + num(line.quantity); }, 0);
        return h("article", { key: sale.id, className: "history-card printable", role: "button", tabIndex: 0, onClick: function () { props.setPrintSale(sale); }, onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.setPrintSale(sale); } } },
          h("div", { className: "history-card-head" },
            h("strong", { className: "history-customer" }, sale.customerName || "-"),
            h("time", null, shortDate(sale.createdAt)),
            h("strong", { className: "history-writer" }, sale.writerName || "-")
          ),
          h("div", { className: "history-meta" },
            h("div", null, h("span", null, "날짜"), h("strong", null, new Date(sale.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }))),
            h("div", null, h("span", null, "할인"), h("strong", null, "-" + won((sale.totals || {}).discount)))
          ),
          sale.customerNote ? h("p", { className: "history-note" }, sale.customerNote) : null,
          h("div", { className: "history-stat" }, h("span", null, "품목/갯수"), h("strong", null, itemCount + "종 · " + quantityCount + "개")),
          h("div", { className: "history-total" }, h("span", null, "총액"), h("strong", null, won(sale.totals.total))),
          h("div", { className: props.settlementAccess ? "history-actions history-actions-admin" : "history-actions history-actions-member" },
            h("button", { onClick: function (event) { event.stopPropagation(); props.setPrintSale(sale); } }, "재출력"),
            h("button", { className: "history-edit", onClick: function (event) { event.stopPropagation(); props.beginSaleEdit(sale); } }, "수정"),
            (sale.editHistory || []).length ? h("button", { className: "history-audit", onClick: function (event) { event.stopPropagation(); setAuditSale(sale); } }, "수정 기록 " + sale.editHistory.length) : null,
            props.settlementAccess ? h("button", { className: "history-delete", onClick: function (event) { event.stopPropagation(); requestDeleteSale(sale); } }, "삭제") : null
          )
        );
      }) : h("p", { className: "empty" }, "저장된 판매 내역이 없습니다."))
    ),
      deleteTarget ? h("div", { className: "history-modal", role: "dialog", "aria-modal": true },
        h("button", { className: "history-modal-backdrop", "aria-label": "닫기", onClick: function () { setDeleteTarget(null); } }),
        h("form", { className: "history-modal-card delete-reason-card", onSubmit: confirmDeleteSale },
          h("div", { className: "history-modal-head" }, h("strong", null, "내역 삭제"), h("button", { className: "ghost small", type: "button", onClick: function () { setDeleteTarget(null); } }, "닫기")),
          h("p", { className: "delete-reason-summary" },
            (deleteTarget.customerName || "내역") + " · " + (deleteTarget.createdAt ? new Date(deleteTarget.createdAt).toLocaleString("ko-KR") : "-")
          ),
          h("label", { className: "delete-reason-field" },
            h("span", null, "삭제 사유"),
            h("textarea", { value: deleteReason, onChange: function (event) { setDeleteReason(event.target.value); }, placeholder: "예: 중복 저장 / 잘못 저장 / 테스트 내역" })
          ),
          h("div", { className: "review-actions" },
            h("button", { className: "ghost", type: "button", onClick: function () { setDeleteTarget(null); } }, "취소"),
            h("button", { className: "primary danger-primary", type: "submit" }, "삭제")
          )
        )
      ) : null,
      editingSale ? h("div", { className: "history-modal", role: "dialog", "aria-modal": true },
        h("button", { className: "history-modal-backdrop", "aria-label": "닫기", onClick: function () { setEditingSale(null); } }),
        h("section", { className: "history-modal-card history-edit-card" },
          h("div", { className: "history-modal-head" }, h("strong", null, "판매 내역 수정"), h("button", { className: "ghost small", onClick: function () { setEditingSale(null); } }, "닫기")),
          h("div", { className: "history-edit-fields" },
            h("label", null, h("span", null, "거래처"), h("input", { value: editingSale.customerName, onChange: function (event) { setEditingSale(Object.assign({}, editingSale, { customerName: event.target.value })); } })),
            h("label", null, h("span", null, "작성자"), h("input", { value: editingSale.writerName, onChange: function (event) { setEditingSale(Object.assign({}, editingSale, { writerName: event.target.value })); } })),
            h("label", { className: "history-vat-field" }, h("input", { type: "checkbox", checked: editingSale.vatEnabled, onChange: function (event) { setEditingSale(Object.assign({}, editingSale, { vatEnabled: event.target.checked })); } }), h("span", null, "VAT 적용"))
          ),
          h("div", { className: "history-edit-lines" }, editingSale.lines.map(function (line, index) {
            return h("div", { className: "history-edit-line", key: line.id },
              h("b", null, (index + 1) + ". " + line.name),
              h("label", null, h("span", null, "수량"), h("input", { type: "number", min: 1, max: MAX_QUANTITY, value: line.quantity, onChange: function (event) { updateDraftLine(line.id, "quantity", event.target.value); } })),
              h("label", null, h("span", null, "단가"), h("input", { type: "number", min: 0, max: MAX_PRICE, value: line.price, onChange: function (event) { updateDraftLine(line.id, "price", event.target.value); } })),
              h("button", { className: "history-line-delete", onClick: function () { removeDraftLine(line.id); } }, "삭제")
            );
          })),
          h("button", { className: "primary history-save-edit", onClick: saveSaleEdit }, "수정 저장")
        )
      ) : null,
      auditSale ? h("div", { className: "history-modal", role: "dialog", "aria-modal": true },
        h("button", { className: "history-modal-backdrop", "aria-label": "닫기", onClick: function () { setAuditSale(null); } }),
        h("section", { className: "history-modal-card" },
          h("div", { className: "history-modal-head" }, h("strong", null, "수정 기록"), h("button", { className: "ghost small", onClick: function () { setAuditSale(null); } }, "닫기")),
          h("div", { className: "history-audit-list" }, (auditSale.editHistory || []).slice().reverse().map(function (entry) {
            return h("article", { key: entry.id },
              h("strong", null, new Date(entry.editedAt).toLocaleString("ko-KR")),
              h("small", null, entry.editor || "관리자"),
              h("ul", null, (entry.changes || []).map(function (change, index) { return h("li", { key: index }, change); }))
            );
          }))
        )
      ) : null,
      deletionLogOpen && props.settlementAccess ? h("div", { className: "history-modal", role: "dialog", "aria-modal": true },
        h("button", { className: "history-modal-backdrop", "aria-label": "닫기", onClick: function () { setDeletionLogOpen(false); } }),
        h("section", { className: "history-modal-card deletion-log-card" },
          h("div", { className: "history-modal-head" }, h("strong", null, "삭제 기록"), h("button", { className: "ghost small", onClick: function () { setDeletionLogOpen(false); } }, "닫기")),
          h("div", { className: "history-audit-list deletion-log-list" }, (props.deletionLogs || []).length ? (props.deletionLogs || []).map(function (entry) {
            return h("article", { key: entry.id },
              h("strong", null, new Date(entry.deletedAt).toLocaleString("ko-KR")),
              h("small", null, (entry.admin || "관리자") + " · " + (entry.reason || "사유 없음")),
              h("ul", null,
                h("li", null, "거래처: " + (entry.customerName || "-")),
                h("li", null, "작성자: " + (entry.writerName || "-")),
                h("li", null, "원본일시: " + (entry.createdAt ? new Date(entry.createdAt).toLocaleString("ko-KR") : "-")),
                h("li", null, "품목/수량: " + (entry.lineCount || 0) + "종 · " + (entry.quantity || 0) + "개"),
                h("li", null, "총액: " + won((entry.totals || {}).total))
              )
            );
          }) : h("p", { className: "empty" }, "삭제 기록이 없습니다."))
        )
      ) : null
    );
  }

  function PrintSheet(props) {
    var pages = receiptPages(props.sale);
    var previewWidthHook = React.useState(window.innerWidth);
    var previewWidth = previewWidthHook[0], setPreviewWidth = previewWidthHook[1];
    React.useEffect(function () {
      function updatePreviewWidth() {
        setPreviewWidth(window.innerWidth);
      }
      window.addEventListener("resize", updatePreviewWidth);
      return function () {
        window.removeEventListener("resize", updatePreviewWidth);
      };
    }, []);
    var previewScale = Math.min(1, Math.max(0.24, (previewWidth - 16) / 1123));
    function printReceipt() {
      if (window.PorsPrint && typeof window.PorsPrint.print === "function") {
        document.body.classList.add("native-printing");
        window.PorsPrint.print();
        setTimeout(function () {
          document.body.classList.remove("native-printing");
        }, 3000);
        return;
      }
      window.print();
    }
    return h("div", { className: "print-area", style: { "--receipt-preview-scale": String(previewScale) } },
      h("div", { className: "receipt-preview-toolbar" },
        h("div", { className: "receipt-preview-heading" },
          h("strong", null, "영수증 미리보기"),
          h("span", { className: "receipt-preview-count" }, "총 " + pages.length + "페이지")
        ),
        h("div", null,
          h("button", { className: "ghost", onClick: props.onClose }, "닫기"),
          h("button", { className: "primary", onClick: printReceipt }, "인쇄")
        )
      ),
      pages.map(function (page) {
        return h("div", { className: "receipt-preview-page", key: page.pageIndex }, [0, 1].map(function (index) {
          return h(Receipt, { key: index, sale: props.sale, store: props.store, copyLabel: index === 0 ? "보관용" : "고객용", pageLines: page.lines, lineStart: page.lineStart, pageIndex: page.pageIndex, pageCount: pages.length, isLastPage: page.isLastPage });
        }));
      })
    );
  }

  function receiptPages(sale) {
    var lines = Array.isArray(sale.lines) ? sale.lines : [];
    var pageLimit = 20;
    var chunks = [];
    if (!lines.length) chunks.push({ start: 0, lines: [] });
    if (lines.length) {
      for (var start = 0; start < lines.length; start += pageLimit) {
        chunks.push({ start: start, lines: lines.slice(start, start + pageLimit) });
      }
    }
    return chunks.map(function (chunk, index) {
      return { lines: chunk.lines, lineStart: chunk.start, pageIndex: index + 1, isLastPage: index === chunks.length - 1 };
    });
  }

  function offshoreSettlementForSale(sale) {
    if (sale && sale.offshoreSettlement) return sale.offshoreSettlement;
    var note = safeText(sale && sale.customerNote || "");
    if (!/무역회사/.test(note)) return null;
    var tradeMatch = note.match(/무역회사\s*(\d+(?:\.\d+)?)%/);
    return offshoreSettlementForTotal(sale && sale.totals, { offshore: true, tradeCompanyName: "MBN", tradeCommissionRate: tradeMatch ? tradeMatch[1] : 5 });
  }

  function receiptTotalsForCopy(sale, copyLabel) {
    var totalsValue = sale.totals || {};
    var offshore = offshoreSettlementForSale(sale);
    var shippingFee = num(totalsValue.shippingFee || sale.shippingFee);
    if (!offshore) return Object.assign({}, totalsValue, { itemSupply: Math.max(0, num(totalsValue.supply) - shippingFee) });
    if (copyLabel === "보관용") {
      return {
        subtotal: totalsValue.subtotal,
        discount: Math.max(0, num(totalsValue.total) - shippingFee - num(offshore.supply)),
        shippingFee: shippingFee,
        itemSupply: offshore.supply,
        supply: offshore.supply + shippingFee,
        vat: offshore.vat,
        total: offshore.receivable + shippingFee
      };
    }
    return {
      subtotal: totalsValue.subtotal,
      discount: totalsValue.discount,
      shippingFee: shippingFee,
      itemSupply: Math.max(0, num(totalsValue.total) - shippingFee),
      supply: totalsValue.total,
      vat: 0,
      total: totalsValue.total
    };
  }

  function Receipt(props) {
    var sale = props.sale;
    var receiptTotals = receiptTotalsForCopy(sale, props.copyLabel);
    var printedCustomerName = safeText(sale.customerName || "").replace(/\s*[\(（][^\)）]*[\)）]/g, "").trim();
    var issuedAt = new Date(sale.createdAt).toLocaleString("ko-KR");
    var writerName = sale.writerName || "";
    var pageIndex = props.pageIndex || 1;
    var pageCount = props.pageCount || 1;
    var pageLines = props.pageLines || sale.lines || [];
    var lineOffset = num(props.lineStart || 0);
    var firstPage = pageIndex === 1;
    var customerCopy = props.copyLabel === "고객용";
    return h("section", { className: "receipt" },
      h("div", { className: "receipt-copy-label" }, props.copyLabel || ""),
      h("h1", { className: "receipt-title" }, "영수증"),
      h("div", { className: customerCopy ? "receipt-customer-line receipt-customer-line-public" : "receipt-customer-line" },
        h("span", null, issuedAt),
        h("span", { className: "receipt-customer-meta" },
          h("strong", { className: "receipt-customer-name" }, "거래처: " + printedCustomerName),
          writerName ? h("small", { className: "receipt-writer-name" }, "작성: " + writerName) : null
        )
      ),
      firstPage ? h("div", { className: "receipt-shop" },
        h("div", { className: "shop-brand" }, "귀족"),
        h("div", { className: "shop-contact" },
          h("strong", null, "kakao ID"),
          h("div", null, h("span", null, "npiercing"), h("span", null, "noblepiercing"))
        )
      ) : null,
      firstPage ? h("div", { className: "shop-address" },
        h("div", null, "서울 중구 남대문시장4길 21"),
        h("div", { className: "shop-room" }, "대도E동 1층 150호"),
        h("div", { className: "shop-phone" }, h("span", null, "H·P : 010-3427-7956"), h("span", null, "H·P : 010-6512-7956"))
      ) : null,
      firstPage ? h("div", { className: "receipt-account" }, "신한 : 110-455-062109  예금주 : 고인경") : null,
      h("table", null,
        h("thead", null, h("tr", null, h("th", null, "번호"), h("th", null, "품목"), h("th", null, "수량"), h("th", null, "단가"), h("th", null, "금액"))),
        h("tbody", null, pageLines.map(function (line, index) {
          return h("tr", { key: line.id },
            h("td", null, lineOffset + index + 1),
            h("td", null, line.name),
            h("td", null, line.quantity),
            h("td", null, won(line.price)),
            h("td", null, won(line.price * line.quantity))
          );
        }))
      ),
      props.isLastPage && props.copyLabel === "보관용" ? h("div", { className: "receipt-tax-summary receipt-tax-summary-keeper" + (num(receiptTotals.shippingFee) ? " has-shipping" : "") },
        h("div", null, h("span", null, "할인된 원가금액"), h("strong", null, won(receiptTotals.itemSupply == null ? receiptTotals.supply : receiptTotals.itemSupply))),
        num(receiptTotals.shippingFee) ? h("div", null, h("span", null, "배송비"), h("strong", null, won(receiptTotals.shippingFee))) : null,
        h("div", null, h("span", null, "세금"), h("strong", null, won(receiptTotals.vat))),
        h("div", null, h("span", null, "총금액"), h("strong", null, won(receiptTotals.total)))
      ) : props.isLastPage ? h("div", { className: "receipt-tax-summary" + (num(receiptTotals.shippingFee) ? " has-shipping" : "") },
        h("div", null, h("span", null, "토탈 원가"), h("strong", null, won(receiptTotals.subtotal))),
        h("div", null, h("span", null, "공급가"), h("strong", null, won(receiptTotals.itemSupply == null ? receiptTotals.supply : receiptTotals.itemSupply))),
        num(receiptTotals.shippingFee) ? h("div", null, h("span", null, "배송비"), h("strong", null, won(receiptTotals.shippingFee))) : null,
        h("div", null, h("span", null, "세금"), h("strong", null, won(receiptTotals.vat))),
        h("div", null, h("span", null, "총금액"), h("strong", null, won(receiptTotals.total)))
      ) : null,
      h("div", { className: "receipt-page-footer" }, pageIndex + " / " + pageCount),
      h("dl", null, row("상품 합계", won(receiptTotals.subtotal)), row("할인", "-" + won(receiptTotals.discount)), num(receiptTotals.shippingFee) ? row("배송비", won(receiptTotals.shippingFee)) : null, row("공급가액", won(receiptTotals.supply)), row("VAT", won(receiptTotals.vat)), h("div", { className: "receipt-total" }, h("dt", null, "총액"), h("dd", null, won(receiptTotals.total))))
    );
  }

  root.render(h(App));

  // APK preview is updated often, so avoid service-worker caching during this build phase.
})();
