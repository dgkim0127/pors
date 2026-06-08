import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { calculateSale, formatWon, lineTotal, makeId, normalizePercent, toNumber } from "./calculations.js";
import { createCategory, createCustomer, createItem, createRepository, seedData } from "./data.js";
import { Icon } from "./icons.js";

const h = React.createElement;
const repository = createRepository();

function App() {
  const [state, setState] = useState(seedData);
  const [loaded, setLoaded] = useState(false);
  const [authorized, setAuthorized] = useState(localStorage.getItem("piercing-pos-authorized") === "yes");
  const [adminKey, setAdminKey] = useState("");
  const [activeTab, setActiveTab] = useState("sale");
  const [activeCategoryId, setActiveCategoryId] = useState("cat_earring");
  const [selectedCustomerId, setSelectedCustomerId] = useState("customer_walkin");
  const [cart, setCart] = useState([]);
  const [printSale, setPrintSale] = useState(null);

  useEffect(() => {
    Promise.resolve(repository.load()).then((data) => {
      setState(data);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    repository.save(state);
  }, [state, loaded]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  const categories = useMemo(
    () => state.categories.filter((category) => category.active).sort((a, b) => a.sort - b.sort),
    [state.categories]
  );
  const customers = useMemo(() => state.customers.filter((customer) => customer.active), [state.customers]);
  const customer = customers.find((entry) => entry.id === selectedCustomerId) || customers[0];
  const activeItems = state.items.filter((item) => item.active && item.categoryId === activeCategoryId);
  const totals = calculateSale(cart, customer);

  function patchState(next) {
    setState((current) => (typeof next === "function" ? next(current) : next));
  }

  function login(event) {
    event.preventDefault();
    const ok = repository.verifyAdminKey(adminKey);
    if (!ok) return alert("관리자키가 맞지 않습니다. 데모 기본키는 0000입니다.");
    localStorage.setItem("piercing-pos-authorized", "yes");
    setAuthorized(true);
  }

  function addItem(item) {
    setCart((current) => {
      const existing = current.find((line) => line.itemId === item.id && line.price === item.price);
      if (existing) return current.map((line) => (line.id === existing.id ? { ...line, quantity: line.quantity + 1 } : line));
      return [
        ...current,
        {
          id: makeId("line"),
          itemId: item.id,
          name: item.name,
          price: item.price,
          quantity: 1,
          discountable: item.discountable
        }
      ];
    });
  }

  function updateCartLine(lineId, patch) {
    setCart((current) =>
      current
        .map((line) => {
          if (line.id !== lineId) return line;
          const nextQuantity = toNumber(patch.quantity ?? line.quantity);
          return { ...line, ...patch, quantity: nextQuantity };
        })
        .filter((line) => line.quantity > 0)
    );
  }

  function completeSale() {
    if (!cart.length) return alert("품목을 먼저 추가해 주세요.");
    const sale = {
      id: makeId("sale"),
      createdAt: new Date().toISOString(),
      customerId: customer.id,
      customerName: customer.name,
      discountRate: customer.discountRate,
      vatEnabled: customer.vatEnabled,
      lines: cart,
      totals
    };
    patchState((current) => ({ ...current, sales: [sale, ...current.sales] }));
    setCart([]);
    setPrintSale(sale);
    setTimeout(() => window.print(), 80);
  }

  function printExisting(sale) {
    setPrintSale(sale);
    setTimeout(() => window.print(), 80);
  }

  if (!loaded) return h("main", { className: "loading" }, "불러오는 중...");
  if (!authorized) return h(LoginScreen, { adminKey, setAdminKey, login, mode: repository.mode });

  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "app-shell" },
      h(Header, { store: state.store, mode: repository.mode, activeTab, setActiveTab }),
      activeTab === "sale" &&
        h(SaleScreen, {
          categories,
          activeCategoryId,
          setActiveCategoryId,
          items: activeItems,
          customers,
          selectedCustomerId,
          setSelectedCustomerId,
          cart,
          updateCartLine,
          addItem,
          totals,
          customer,
          completeSale,
          clearCart: () => setCart([])
        }),
      activeTab === "manage" && h(ManageScreen, { state, patchState }),
      activeTab === "history" && h(HistoryScreen, { sales: state.sales, printExisting })
    ),
    printSale && h(PrintSheet, { sale: printSale, store: state.store })
  );
}

function LoginScreen({ adminKey, setAdminKey, login, mode }) {
  return h(
    "main",
    { className: "login-screen" },
    h("section", { className: "login-card" },
      h("div", { className: "brand-mark" }, "P"),
      h("h1", null, "피어싱 계산"),
      h("p", null, "관리자키를 입력하면 계산, 품목관리, 영수증 출력을 바로 사용할 수 있습니다."),
      h("form", { onSubmit: login },
        h("label", null, "관리자키"),
        h("input", {
          value: adminKey,
          onChange: (event) => setAdminKey(event.target.value),
          placeholder: "0000",
          autoFocus: true,
          type: "password"
        }),
        h("button", { className: "primary", type: "submit" }, "시작하기")
      ),
      h("small", null, mode === "supabase" ? "Supabase 연결 모드" : "로컬 데모 저장 모드")
    )
  );
}

function Header({ store, mode, activeTab, setActiveTab }) {
  return h(
    "header",
    { className: "topbar" },
    h("div", null, h("strong", null, store.name), h("span", null, mode === "supabase" ? "Cloud" : "Local demo")),
    h(
      "nav",
      null,
      [
        ["sale", "계산"],
        ["manage", "관리"],
        ["history", "내역"]
      ].map(([id, label]) =>
        h("button", { key: id, className: activeTab === id ? "active" : "", onClick: () => setActiveTab(id) }, label)
      )
    )
  );
}

function SaleScreen(props) {
  return h(
    "main",
    { className: "sale-grid" },
    h("section", { className: "catalog-panel" },
      h("div", { className: "category-tabs" },
        props.categories.map((category) =>
          h("button", {
            key: category.id,
            className: props.activeCategoryId === category.id ? "active" : "",
            onClick: () => props.setActiveCategoryId(category.id)
          }, category.name)
        )
      ),
      h("div", { className: "item-grid" },
        props.items.map((item) =>
          h("button", { key: item.id, className: "item-tile", onClick: () => props.addItem(item) },
            h("span", null, item.name),
            h("strong", null, formatWon(item.price)),
            !item.discountable && h("em", null, "할인 제외")
          )
        )
      )
    ),
    h("aside", { className: "cart-panel" },
      h("div", { className: "customer-row" },
        h("label", null, "거래처"),
        h("select", { value: props.selectedCustomerId, onChange: (event) => props.setSelectedCustomerId(event.target.value) },
          props.customers.map((customer) => h("option", { key: customer.id, value: customer.id }, `${customer.name} · ${customer.discountRate}%${customer.vatEnabled ? " · VAT" : ""}`))
        )
      ),
      h("div", { className: "cart-lines" },
        props.cart.length
          ? props.cart.map((line) => h(CartLine, { key: line.id, line, updateCartLine: props.updateCartLine }))
          : h("p", { className: "empty" }, "품목을 눌러 장바구니에 담아 주세요.")
      ),
      h(Totals, { totals: props.totals, customer: props.customer }),
      h("div", { className: "action-row" },
        h("button", { className: "ghost", onClick: props.clearCart }, "비우기"),
        h("button", { className: "primary", onClick: props.completeSale }, h(Icon, { name: "print" }), "저장/출력")
      )
    )
  );
}

function CartLine({ line, updateCartLine }) {
  return h("article", { className: "cart-line" },
    h("div", null, h("strong", null, line.name), h("span", null, `${formatWon(line.price)} · ${line.discountable ? "할인 가능" : "할인 제외"}`)),
    h("div", { className: "qty-controls" },
      h("button", { title: "수량 감소", onClick: () => updateCartLine(line.id, { quantity: line.quantity - 1 }) }, h(Icon, { name: "minus", size: 16 })),
      h("input", { value: line.quantity, inputMode: "numeric", onChange: (event) => updateCartLine(line.id, { quantity: event.target.value }) }),
      h("button", { title: "수량 증가", onClick: () => updateCartLine(line.id, { quantity: line.quantity + 1 }) }, h(Icon, { name: "plus", size: 16 })),
      h("button", { title: "삭제", onClick: () => updateCartLine(line.id, { quantity: 0 }) }, h(Icon, { name: "trash", size: 16 }))
    ),
    h("label", { className: "price-edit" }, "단가", h("input", {
      value: line.price,
      inputMode: "numeric",
      onChange: (event) => updateCartLine(line.id, { price: Math.max(0, toNumber(event.target.value)) })
    })),
    h("b", null, formatWon(lineTotal(line)))
  );
}

function Totals({ totals, customer }) {
  return h("dl", { className: "totals" },
    h("div", null, h("dt", null, "상품 합계"), h("dd", null, formatWon(totals.subtotal))),
    h("div", null, h("dt", null, `할인 ${customer?.discountRate || 0}%`), h("dd", null, `-${formatWon(totals.discount)}`)),
    h("div", null, h("dt", null, "공급가액"), h("dd", null, formatWon(totals.supply))),
    h("div", null, h("dt", null, "VAT"), h("dd", null, formatWon(totals.vat))),
    h("div", { className: "grand" }, h("dt", null, "총액"), h("dd", null, formatWon(totals.total)))
  );
}

function ManageScreen({ state, patchState }) {
  return h("main", { className: "manage-grid" },
    h(ManagementCard, { title: "카테고리 추가", icon: "settings" },
      h(CategoryForm, { patchState })
    ),
    h(ManagementCard, { title: "품목 추가", icon: "plus" },
      h(ItemForm, { categories: state.categories, patchState })
    ),
    h(ManagementCard, { title: "거래처 추가", icon: "save" },
      h(CustomerForm, { patchState })
    ),
    h("section", { className: "wide-panel" },
      h("h2", null, "등록 목록"),
      h("div", { className: "admin-lists" },
        h(AdminList, { title: "품목", rows: state.items.map((item) => ({ ...item, meta: formatWon(item.price) })) }),
        h(AdminList, { title: "거래처", rows: state.customers.map((customer) => ({ ...customer, meta: `${customer.discountRate}% · ${customer.vatEnabled ? "VAT" : "VAT 없음"}` })) })
      )
    )
  );
}

function ManagementCard({ title, icon, children }) {
  return h("section", { className: "management-card" }, h("h2", null, h(Icon, { name: icon }), title), children);
}

function CategoryForm({ patchState }) {
  const [name, setName] = useState("");
  const [discountableDefault, setDiscountableDefault] = useState(true);
  return h("form", { className: "stack-form", onSubmit: (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    patchState((state) => ({ ...state, categories: [...state.categories, createCategory(name.trim(), discountableDefault)] }));
    setName("");
  } },
    h("input", { value: name, onChange: (event) => setName(event.target.value), placeholder: "예: 큐빅" }),
    h("label", { className: "check" }, h("input", { type: "checkbox", checked: discountableDefault, onChange: (event) => setDiscountableDefault(event.target.checked) }), "기본 할인 가능"),
    h("button", { className: "primary" }, "카테고리 저장")
  );
}

function ItemForm({ categories, patchState }) {
  const first = categories[0]?.id || "";
  const [form, setForm] = useState({ name: "", price: "", categoryId: first, discountable: true });
  return h("form", { className: "stack-form", onSubmit: (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    patchState((state) => ({ ...state, items: [...state.items, createItem({ ...form, name: form.name.trim(), price: toNumber(form.price) })] }));
    setForm({ ...form, name: "", price: "" });
  } },
    h("input", { value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }), placeholder: "예: 진주" }),
    h("input", { value: form.price, inputMode: "numeric", onChange: (event) => setForm({ ...form, price: event.target.value }), placeholder: "단가" }),
    h("select", { value: form.categoryId, onChange: (event) => {
      const category = categories.find((entry) => entry.id === event.target.value);
      setForm({ ...form, categoryId: event.target.value, discountable: category?.discountableDefault ?? true });
    } }, categories.map((category) => h("option", { key: category.id, value: category.id }, category.name))),
    h("label", { className: "check" }, h("input", { type: "checkbox", checked: form.discountable, onChange: (event) => setForm({ ...form, discountable: event.target.checked }) }), "할인 가능"),
    h("button", { className: "primary" }, "품목 저장")
  );
}

function CustomerForm({ patchState }) {
  const [form, setForm] = useState({ name: "", discountRate: "", vatEnabled: true });
  return h("form", { className: "stack-form", onSubmit: (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    patchState((state) => ({ ...state, customers: [...state.customers, createCustomer({ name: form.name.trim(), discountRate: normalizePercent(form.discountRate), vatEnabled: form.vatEnabled })] }));
    setForm({ name: "", discountRate: "", vatEnabled: true });
  } },
    h("input", { value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }), placeholder: "거래처명" }),
    h("input", { value: form.discountRate, inputMode: "decimal", onChange: (event) => setForm({ ...form, discountRate: event.target.value }), placeholder: "할인율 %" }),
    h("label", { className: "check" }, h("input", { type: "checkbox", checked: form.vatEnabled, onChange: (event) => setForm({ ...form, vatEnabled: event.target.checked }) }), "VAT 적용"),
    h("button", { className: "primary" }, "거래처 저장")
  );
}

function AdminList({ title, rows }) {
  return h("div", { className: "admin-list" },
    h("h3", null, title),
    rows.map((row) => h("div", { key: row.id, className: "admin-row" }, h("span", null, row.name), h("b", null, row.meta)))
  );
}

function HistoryScreen({ sales, printExisting }) {
  const [query, setQuery] = useState("");
  const filtered = sales.filter((sale) => sale.customerName.includes(query) || sale.lines.some((line) => line.name.includes(query)));
  return h("main", { className: "history-panel" },
    h("div", { className: "search-row" }, h(Icon, { name: "search" }), h("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "거래처 또는 품목 검색" })),
    h("div", { className: "history-list" },
      filtered.length
        ? filtered.map((sale) => h("article", { key: sale.id, className: "history-card" },
          h("div", null, h("strong", null, sale.customerName), h("span", null, new Date(sale.createdAt).toLocaleString("ko-KR"))),
          h("p", null, sale.lines.map((line) => `${line.name} ${line.quantity}개`).join(", ")),
          h("b", null, formatWon(sale.totals.total)),
          h("button", { onClick: () => printExisting(sale) }, h(Icon, { name: "print", size: 16 }), "재출력")
        ))
        : h("p", { className: "empty" }, "저장된 판매 내역이 없습니다.")
    )
  );
}

function PrintSheet({ sale, store }) {
  return h("div", { className: "print-area" }, [0, 1].map((index) => h(Receipt, { key: index, sale, store })));
}

function Receipt({ sale, store }) {
  return h("section", { className: "receipt" },
    h("h1", null, store.name),
    h("p", null, new Date(sale.createdAt).toLocaleString("ko-KR")),
    h("p", null, `거래처: ${sale.customerName}`),
    h("table", null,
      h("thead", null, h("tr", null, h("th", null, "품목"), h("th", null, "수량"), h("th", null, "단가"), h("th", null, "금액"))),
      h("tbody", null, sale.lines.map((line) => h("tr", { key: line.id }, h("td", null, line.name), h("td", null, line.quantity), h("td", null, formatWon(line.price)), h("td", null, formatWon(lineTotal(line))))))
    ),
    h("dl", null,
      h("div", null, h("dt", null, "상품 합계"), h("dd", null, formatWon(sale.totals.subtotal))),
      h("div", null, h("dt", null, "할인"), h("dd", null, `-${formatWon(sale.totals.discount)}`)),
      h("div", null, h("dt", null, "공급가액"), h("dd", null, formatWon(sale.totals.supply))),
      h("div", null, h("dt", null, "VAT"), h("dd", null, formatWon(sale.totals.vat))),
      h("div", { className: "receipt-total" }, h("dt", null, "총액"), h("dd", null, formatWon(sale.totals.total)))
    )
  );
}

createRoot(document.getElementById("root")).render(h(App));
