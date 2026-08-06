(function (global) {
  "use strict";

  var React = global.React;
  var h = React && React.createElement;
  var CACHE_LIST_KEY = "pors-online-quotes:list:v1";
  var CACHE_DETAIL_PREFIX = "pors-online-quotes:detail:v1:";

  function clampQuantity(value, maximum) {
    var parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(maximum, parsed));
  }

  function asMoney(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }

  function formatMoney(value) {
    return asMoney(value).toLocaleString("ko-KR") + "원";
  }

  function makeIdempotencyKey(prefix) {
    var randomPart =
      global.crypto && typeof global.crypto.randomUUID === "function"
        ? global.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    return prefix + ":" + randomPart;
  }

  function readCache(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function writeCache(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {
      // Cache failure must never block online quote work.
    }
  }

  function optionPairs(item) {
    var selected = item && item.selectedOptions;
    var pairs = [];
    if (Array.isArray(selected)) {
      pairs = selected
        .map(function (entry) {
          return {
            label:
              entry.groupLabel ||
              entry.groupName ||
              entry.label ||
              entry.name ||
              "옵션",
            value:
              entry.valueLabel ||
              entry.valueName ||
              entry.value ||
              entry.optionValue ||
              "",
          };
        })
        .filter(function (entry) {
          return entry.value !== "";
        });
    } else if (selected && typeof selected === "object") {
      pairs = Object.keys(selected).map(function (key) {
        var value = selected[key];
        return {
          label: key,
          value:
            value && typeof value === "object"
              ? value.label || value.name || value.value || ""
              : String(value == null ? "" : value),
        };
      });
    }
    if (pairs.length) return pairs;

    var legacy = [];
    if (item && (item.selectedColor || item.color)) {
      legacy.push({ label: "색상", value: item.selectedColor || item.color });
    }
    var barLength = item && (item.barLength || item.bar_length || item.length);
    if (barLength) {
      legacy.push({ label: "바 길이", value: barLength });
    }
    if (item && (item.selectedSize || item.size)) {
      var size = item.selectedSize || item.size;
      if (String(size) !== String(barLength || "")) {
        legacy.push({ label: "바 길이/사이즈", value: size });
      }
    }
    return legacy;
  }

  function webBuyerLabel(quote) {
    var name = String(
      (quote && (quote.companyName || quote.buyerCompany)) || "웹 거래처"
    ).trim();
    return "웹-" + (name || "웹 거래처");
  }

  function quoteItemsFromDetail(detail) {
    var quote = detail && detail.quote ? detail.quote : detail;
    if (quote && Array.isArray(quote.items)) return quote.items;
    if (detail && Array.isArray(detail.items)) return detail.items;
    return null;
  }

  function requestedQuantityFromDetail(detail) {
    var items = quoteItemsFromDetail(detail);
    if (!items) return null;
    return items.reduce(function (sum, item) {
      var quantity = Number(item.requestedQuantity || item.quantity || 0);
      return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
    }, 0);
  }

  function quoteListQuantity(quote) {
    if (quote && quote.requestedQuantity != null) {
      var requestedQuantity = Number(quote.requestedQuantity);
      if (Number.isFinite(requestedQuantity) && requestedQuantity >= 0) {
        return requestedQuantity;
      }
    }
    var detailQuantity = requestedQuantityFromDetail(quote);
    if (detailQuantity != null) return detailQuantity;
    var itemCount = Number(quote && quote.itemCount);
    return Number.isFinite(itemCount) && itemCount >= 0 ? itemCount : 0;
  }

  function resolveItemImageUrl(value) {
    var imageUrl = String(value || "").trim();
    if (!imageUrl || imageUrl.charAt(0) !== "/") return imageUrl;

    var configuredApiBase = String(
      global.PORS_NOBLESSE_API_BASE_URL || ""
    ).trim();
    var originMatch = configuredApiBase.match(/^https?:\/\/[^/]+/i);
    return originMatch ? originMatch[0] + imageUrl : imageUrl;
  }

  function resolveItemImage(item) {
    var imageSet = (item && item.imageSet) || {};
    var productImage = (item && item.productImage) || {};
    var gallery =
      imageSet.gallery && imageSet.gallery.length ? imageSet.gallery[0] : null;
    var galleryUrls = (gallery && gallery.urls) || {};
    return resolveItemImageUrl(
      (item && (item.imageUrl || item.productImageUrl)) ||
      productImage.url ||
      (gallery &&
        (gallery.thumb ||
          gallery.card ||
          gallery.detail ||
          galleryUrls.thumb ||
          galleryUrls.card ||
          galleryUrls.detail)) ||
      imageSet.thumb ||
      imageSet.card ||
      imageSet.detail ||
      ""
    );
  }

  function draftFromQuote(detail) {
    var items = quoteItemsFromDetail(detail) || [];
    return {
      items: items.map(function (item) {
        var requested = Number(item.requestedQuantity || item.quantity || 0);
        var prepared =
          item.confirmedQuantity == null
            ? requested
            : Number(item.confirmedQuantity);
        return {
          id: item.id,
          preparedQuantity: clampQuantity(prepared, requested),
          cancellationReason: item.cancellationReason || "",
          cancellationNote: item.cancellationNote || "",
          itemNote: item.itemNote || "",
        };
      }),
    };
  }

  function buildWritePayload(detail, draft, action) {
    var quoteItems = quoteItemsFromDetail(detail) || [];
    var draftById = {};
    (draft.items || []).forEach(function (item) {
      draftById[item.id] = item;
    });

    var items = quoteItems.map(function (item) {
      var requested = Number(item.requestedQuantity || item.quantity || 0);
      var source = draftById[item.id] || {};
      var prepared = clampQuantity(source.preparedQuantity, requested);
      if (prepared < requested && !String(source.cancellationReason || "").trim()) {
        throw new Error("준비하지 못한 수량에는 취소 사유가 필요합니다.");
      }
      return {
        id: item.id,
        preparedQuantity: prepared,
        cancellationReason: String(source.cancellationReason || "").trim(),
        cancellationNote: String(source.cancellationNote || "").trim(),
        itemNote: String(source.itemNote || "").trim(),
      };
    });

    return {
      expectedVersion:
        Number(detail && detail.pos && detail.pos.state && detail.pos.state.version) ||
        1,
      idempotencyKey: makeIdempotencyKey(action),
      items: items,
    };
  }

  function buildReceiptLinkPayload(detail, sale) {
    var quote = detail && detail.quote ? detail.quote : detail;
    if (!sale || !sale.id) {
      throw new Error("기존 PORS 영수증을 선택해 주세요.");
    }
    var totals = sale.totals || {};
    return {
      expectedVersion:
        Number(detail && detail.pos && detail.pos.state && detail.pos.state.version) ||
        1,
      idempotencyKey: makeIdempotencyKey("receipt-link"),
      receiptId: String(sale.id),
      receiptSnapshot: {
        saleId: String(sale.id),
        customerName: String(sale.customerName || ""),
        createdAt: sale.createdAt || null,
        supplyAmount: asMoney(totals.supply),
        vatAmount: asMoney(totals.vat),
        totalAmount: asMoney(totals.total),
        lineCount: Array.isArray(sale.lines) ? sale.lines.length : 0,
      },
    };
  }

  function groupPriceBands(pricing) {
    if (pricing && Array.isArray(pricing.priceBands)) return pricing.priceBands;
    var groups = {};
    ((pricing && pricing.lines) || []).forEach(function (line) {
      var price = asMoney(line.unitPrice);
      if (!groups[price]) groups[price] = 0;
      groups[price] += Number(line.quantity || line.preparedQuantity || 0);
    });
    return Object.keys(groups)
      .map(function (key) {
        return { unitPrice: Number(key), quantity: groups[key] };
      })
      .sort(function (a, b) {
        return a.unitPrice - b.unitPrice;
      });
  }

  function apiBase() {
    var configured = String(global.PORS_NOBLESSE_API_BASE_URL || "").trim();
    if (!configured) {
      throw new Error("웹 견적 API 주소가 설정되지 않았습니다.");
    }
    return configured.replace(/\/+$/, "");
  }

  function quoteReadToken() {
    var configured = String(global.PORS_NOBLESSE_READ_TOKEN || "").trim();
    if (configured) return configured;
    var writeToken = String(global.PORS_NOBLESSE_WRITE_TOKEN || "").trim();
    if (!writeToken) {
      throw new Error("웹 견적 읽기 설정이 필요합니다.");
    }
    return writeToken;
  }

  function quoteWriteToken() {
    var configured = String(global.PORS_NOBLESSE_WRITE_TOKEN || "").trim();
    if (!configured) {
      throw new Error("이 기기에 웹 견적 작업 권한이 설정되지 않았습니다.");
    }
    return configured;
  }

  function canDeviceWrite() {
    try {
      quoteWriteToken();
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function readRequest(path) {
    var response = await global.fetch(apiBase() + path, {
      method: "GET",
      headers: {
        "X-Pors-Quote-Read-Token": quoteReadToken(),
        "Content-Type": "application/json",
      },
    });
    var payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }
    if (!response.ok) {
      var error = new Error(
        payload.error || payload.message || "웹 견적을 불러오지 못했습니다."
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function deviceWriteRequest(path, options) {
    var response = await global.fetch(apiBase() + path, {
      method: (options && options.method) || "POST",
      headers: {
        "X-Pors-Quote-Write-Token": quoteWriteToken(),
        "Content-Type": "application/json",
      },
      body:
        options && options.body != null
          ? JSON.stringify(options.body)
          : undefined,
    });
    var payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }
    if (!response.ok) {
      var error = new Error(
        payload.error || payload.message || "웹 견적 작업에 실패했습니다."
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function features() {
    return Object.assign(
      { read: true, picking: true, pricing: true, finalize: true, publish: true, linkReceipt: true },
      global.PORS_NOBLESSE_FEATURES || {}
    );
  }

  function field(label, control, className) {
    return h(
      "label",
      { className: "online-quote-field " + (className || "") },
      h("span", null, label),
      control
    );
  }

  function QuoteList(props) {
    var quotes = props.quotes || [];
    return h(
      "section",
      { className: "online-quotes-list" },
      h(
        "div",
        { className: "online-quotes-toolbar" },
        h(
          "div",
          { className: "online-quotes-heading__actions" },
          h(
            "button",
            {
              type: "button",
              className: "online-quotes-refresh",
              onClick: props.onReload,
              disabled: props.busy,
              title: "새로고침",
              "aria-label": "새로고침",
            },
            h("span", { "aria-hidden": "true" }, "↻")
          )
        )
      ),
      !props.online
        ? h("p", { className: "online-quotes-offline" }, "오프라인: 마지막 조회 내용만 볼 수 있습니다.")
        : null,
      props.error ? h("p", { className: "online-quotes-error" }, props.error) : null,
      quotes.length
        ? h(
            "div",
            { className: "online-quotes-list__rows" },
            quotes.map(function (quote) {
              var pricing = quote.pos && quote.pos.pricing;
              return h(
                "button",
                {
                  type: "button",
                  className: "online-quote-list-row",
                  key: quote.id,
                  onClick: function () {
                    props.onOpen(quote.id);
                  },
                },
                h("span", { className: "online-quote-list-row__main" },
                  h("strong", null, webBuyerLabel(quote)),
                  h("span", { className: "online-quote-list-row__chevron", "aria-hidden": "true" }, "⌄")
                ),
                h("span", { className: "online-quote-list-row__summary" },
                  h("strong", { className: "online-quote-list-row__price" }, pricing ? formatMoney(pricing.totalAmount) : formatMoney(quote.confirmedTotal || quote.requestedTotal)),
                  h("span", { className: "online-quote-list-row__quantity" }, quoteListQuantity(quote) + "개")
                )
              );
            })
          )
        : h(
            "div",
            { className: "online-quotes-empty" },
            h("strong", null, props.busy ? "견적을 불러오는 중입니다." : "접수된 온라인 견적이 없습니다."),
            h("p", null, "새 견적 요청이 들어오면 이 목록에 표시됩니다.")
          )
    );
  }

  function OptionList(props) {
    var pairs = optionPairs(props.item);
    if (!pairs.length) return null;
    return h(
      "dl",
      { className: "online-quote-options" },
      pairs.map(function (pair, index) {
        return h(
          React.Fragment,
          { key: pair.label + ":" + pair.value + ":" + index },
          h("dt", null, pair.label),
          h("dd", null, pair.value)
        );
      })
    );
  }

  function QuoteItem(props) {
    var item = props.item;
    var requested = Number(item.requestedQuantity || item.quantity || 0);
    var draft = props.draft;
    var image = resolveItemImage(item);
    var prepared = clampQuantity(draft.preparedQuantity, requested);
    var cancelled = requested - prepared;
    var canWrite = props.online && props.canWrite && !props.finalized;
    var soldOut = prepared === 0 && draft.cancellationReason === "품절";
    var partiallyPrepared = prepared > 0 && prepared < requested;

    function setFullyPrepared() {
      props.onChange("preparedQuantity", requested);
      props.onChange("cancellationReason", "");
      props.onChange("cancellationNote", "");
    }

    function setPartiallyPrepared() {
      if (partiallyPrepared) {
        if (!draft.cancellationReason || draft.cancellationReason === "품절") {
          props.onChange("cancellationReason", "수량 부족");
        }
        return;
      }
      if (typeof global.prompt !== "function") return;
      var entered = global.prompt(
        "준비 가능한 수량을 입력하세요.",
        String(Math.max(1, requested - 1))
      );
      if (entered == null) return;
      var partialQuantity = clampQuantity(entered, requested);
      if (partialQuantity <= 0) {
        setSoldOut();
        return;
      }
      if (partialQuantity >= requested) {
        setFullyPrepared();
        return;
      }
      props.onChange("preparedQuantity", partialQuantity);
      props.onChange("cancellationReason", "수량 부족");
    }

    function setSoldOut() {
      props.onChange("preparedQuantity", 0);
      props.onChange("cancellationReason", "품절");
      props.onChange("cancellationNote", "");
    }

    return h(
      "article",
      { className: "online-quote-item" + (soldOut ? " online-quote-item--sold-out" : "") },
      h(
        "div",
        { className: "online-quote-item__product" },
        image
          ? h("img", { src: image, alt: item.productName || item.name || "상품" })
          : h("div", { className: "online-quote-item__placeholder" }, "사진 없음"),
        h("div", null,
          h("strong", null, item.productName || item.name || "상품"),
          h("code", null, item.productCode || item.code || ""),
          h(OptionList, { item: item })
        )
      ),
      h(
        "div",
        { className: "online-quote-item__picking" },
        h("div", { className: "online-quote-quantity-summary" },
          h("span", null, "요청 ", h("b", null, requested)),
          h("span", null, "준비 ", h("b", null, prepared)),
          h("span", null, "취소 ", h("b", null, cancelled))
        ),
        field(
          "준비 수량",
          h("input", {
            type: "number",
            inputMode: "numeric",
            min: 0,
            max: requested,
            value: prepared,
            disabled: !canWrite || soldOut,
            onChange: function (event) {
              props.onChange("preparedQuantity", clampQuantity(event.target.value, requested));
            },
          })
        ),
        h(
          "div",
          { className: "online-quote-item__quick-actions" },
          h(
            "button",
            {
              type: "button",
              disabled: !canWrite,
              onClick: setFullyPrepared,
            },
            "전부 준비"
          ),
          h(
            "button",
            {
              type: "button",
              className: partiallyPrepared ? "is-selected" : "",
              disabled: !canWrite || requested < 2,
              "aria-pressed": partiallyPrepared,
              onClick: setPartiallyPrepared,
            },
            "부분 준비"
          ),
          h(
            "button",
            {
              type: "button",
              className: soldOut ? "is-selected" : "",
              disabled: !canWrite,
              "aria-pressed": soldOut,
              onClick: setSoldOut,
            },
            "품절"
          )
        ),
        cancelled > 0 && !soldOut
          ? field(
              "취소 사유",
              h("input", {
                value: draft.cancellationReason,
                disabled: !canWrite,
                onChange: function (event) {
                  props.onChange("cancellationReason", event.target.value);
                },
                placeholder: "품절, 수량 부족 등",
              })
            )
          : null
      )
    );
  }

  function PriceSummary(props) {
    var pricing = props.pricing || {};
    return h(
      "aside",
      { className: "online-quote-price-summary" },
      h("div", null,
        h("strong", null, props.customerLabel || "웹 거래처"),
        h("span", null, "웹 견적 · 할인 0% 고정")
      ),
      h(
        "ul",
        null,
        groupPriceBands(pricing).map(function (band) {
          return h(
            "li",
            { key: band.unitPrice },
            h("span", null, formatMoney(band.unitPrice) + " × " + band.quantity + "개"),
            h("strong", null, formatMoney(band.unitPrice * band.quantity))
          );
        })
      ),
      h("dl", null,
        h("div", null, h("dt", null, "소계"), h("dd", null, formatMoney(pricing.subtotal))),
        h("div", null, h("dt", null, "공급가"), h("dd", null, formatMoney(pricing.supplyAmount))),
        h("div", null, h("dt", null, "VAT"), h("dd", null, formatMoney(pricing.vatAmount))),
        h("div", { className: "online-quote-price-summary__total" },
          h("dt", null, "최종 합계"),
          h("dd", null, formatMoney(pricing.totalAmount))
        )
      )
    );
  }

  function ReceiptLinker(props) {
    var selectedHook = React.useState("");
    var selectedId = selectedHook[0];
    var setSelectedId = selectedHook[1];
    var selectedSale = (props.sales || []).find(function (sale) {
      return String(sale.id) === String(selectedId);
    });
    if (!props.published) return null;
    return h(
      "details",
      { className: "online-quote-extra" },
      h("summary", null, "기존 PORS 영수증 수동 연결"),
      h("div", { className: "online-quote-extra__body" },
        h("p", null, "계산 화면에서 이미 저장·출력한 영수증만 연결합니다. 새 판매나 결제는 만들지 않습니다."),
        field(
          "기존 영수증",
          h(
            "select",
            {
              value: selectedId,
              disabled: !props.online || !props.canWrite || props.busy,
              onChange: function (event) { setSelectedId(event.target.value); },
            },
            h("option", { value: "" }, "영수증 선택"),
            (props.sales || []).map(function (sale) {
              var total = sale.totals && sale.totals.total;
              return h(
                "option",
                { key: sale.id, value: sale.id },
                (sale.customerName || "거래처") + " · " + formatMoney(total) + " · " + String(sale.createdAt || "").slice(0, 10)
              );
            })
          )
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || !props.canWrite || props.busy || !selectedSale || Boolean(props.linkedReceiptId),
            onClick: function () {
              if (global.confirm("선택한 기존 PORS 영수증을 이 웹 견적에 연결할까요?")) {
                props.onLink(selectedSale);
              }
            },
          },
          props.linkedReceiptId ? "영수증 연결됨" : "선택한 영수증 연결"
        )
      )
    );
  }

  function QuoteDetail(props) {
    var detail = props.detail;
    var quote = detail.quote || detail;
    var quoteItems = quoteItemsFromDetail(detail) || [];
    var itemDrafts = {};
    (props.draft.items || []).forEach(function (item) {
      itemDrafts[item.id] = item;
    });
    var finalized = Boolean(
      detail.pos &&
        (detail.pos.finalizedAt ||
          (detail.pos.state && detail.pos.state.finalizedAt))
    );
    var published = Boolean(
      detail.pos &&
        (detail.pos.publishedAt ||
          (detail.pos.state && detail.pos.state.publishedAt))
    );

    return h(
      "section",
      { className: "online-quote-detail" },
      h(
        "header",
        { className: "online-quote-detail__header" },
        h(
          "button",
          { type: "button", onClick: props.onBack, className: "online-quote-back" },
          "← 목록"
        ),
        h("div", null,
          h("h2", null, quote.quoteNumber || quote.inquiryNumber || "온라인 견적")
        )
      ),
      !props.online
        ? h("p", { className: "online-quotes-offline" }, "오프라인: 저장·가격 계산·확정은 사용할 수 없습니다.")
        : null,
      props.error ? h("p", { className: "online-quotes-error" }, props.error) : null,
      !props.canWrite
        ? h("p", { className: "online-quotes-offline" }, "이 기기에 웹 견적 작업 권한이 설정되지 않았습니다.")
        : null,
      h(
        "div",
        { className: "online-quote-detail__items" },
        quoteItems.map(function (item) {
          return h(QuoteItem, {
            key: item.id,
            item: item,
            draft: itemDrafts[item.id] || {
              preparedQuantity: 0,
              cancellationReason: "",
            },
            online: props.online,
            canWrite: props.canWrite,
            finalized: finalized,
            onChange: function (fieldName, value) {
              props.onItemChange(item.id, fieldName, value);
            },
          });
        })
      ),
      h(PriceSummary, {
        pricing: props.pricing,
        customerLabel: webBuyerLabel(quote),
      }),
      h(
        "div",
        { className: "online-quote-action-bar" },
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || !props.canWrite || props.busy || finalized || !features().picking,
            onClick: props.onSavePicking,
          },
          "임시 저장"
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || !props.canWrite || props.busy || finalized || !features().pricing,
            onClick: props.onPreview,
          },
          "가격 다시 계산"
        ),
        h(
          "button",
          {
            type: "button",
            className: "online-quotes-primary",
            disabled: !props.online || !props.canWrite || props.busy || finalized || !features().finalize,
            onClick: props.onFinalize,
          },
          finalized ? "견적 확정됨" : "견적 확정"
        ),
        h(
          "button",
          {
            type: "button",
            className: "online-quotes-primary",
            disabled: !props.online || !props.canWrite || props.busy || !finalized || published || !features().publish,
            onClick: props.onPublish,
          },
          published ? "고객 공개됨" : "고객에게 견적 공개"
        )
      ),
      h(ReceiptLinker, {
        online: props.online,
        canWrite: props.canWrite,
        busy: props.busy,
        published: published,
        linkedReceiptId: detail.pos && detail.pos.state && detail.pos.state.linkedReceiptId,
        sales: props.sales,
        onLink: props.onLinkReceipt,
      })
    );
  }

  function OnlineQuotesScreen(props) {
    if (!React || !h) return null;
    var configurationError = "";
    try {
      apiBase();
    } catch (error) {
      configurationError = error.message;
    }
    if (configurationError) {
      return h("main", { className: "online-quotes-unavailable" },
        h("strong", null, "웹 견적이 비활성화되었습니다."),
        h("p", null, configurationError)
      );
    }
    var listHook = React.useState(readCache(CACHE_LIST_KEY, []));
    var quotes = listHook[0];
    var setQuotes = listHook[1];
    var detailHook = React.useState(null);
    var detail = detailHook[0];
    var setDetail = detailHook[1];
    var draftHook = React.useState(null);
    var draft = draftHook[0];
    var setDraft = draftHook[1];
    var pricingHook = React.useState(null);
    var pricing = pricingHook[0];
    var setPricing = pricingHook[1];
    var busyHook = React.useState(false);
    var busy = busyHook[0];
    var setBusy = busyHook[1];
    var errorHook = React.useState("");
    var error = errorHook[0];
    var setError = errorHook[1];
    var online = props.online !== false;
    var canWrite = online && canDeviceWrite();

    React.useEffect(
      function () {
        if (features().read) loadQuotes();
      },
      [online]
    );

    async function loadQuotes() {
      if (!online) {
        setQuotes(readCache(CACHE_LIST_KEY, []));
        return;
      }
      setBusy(true);
      setError("");
      try {
        var response = await readRequest("/pors/quotes");
        var rows = response.quotes || response.items || [];
        var enrichedRows = await Promise.all(
          rows.map(async function (quote) {
            var detail = readCache(CACHE_DETAIL_PREFIX + quote.id, null);
            if (!detail) {
              try {
                detail = await readRequest(
                  "/pors/quotes/" + encodeURIComponent(quote.id)
                );
                writeCache(CACHE_DETAIL_PREFIX + quote.id, detail);
              } catch (_detailError) {
                return quote;
              }
            }
            var requestedQuantity = requestedQuantityFromDetail(detail);
            return requestedQuantity == null
              ? quote
              : Object.assign({}, quote, { requestedQuantity: requestedQuantity });
          })
        );
        setQuotes(enrichedRows);
        writeCache(CACHE_LIST_KEY, enrichedRows);
      } catch (loadError) {
        setError(loadError.message);
      } finally {
        setBusy(false);
      }
    }

    async function loadQuoteDetail(quoteId) {
      var response = online
        ? await readRequest("/pors/quotes/" + encodeURIComponent(quoteId))
        : readCache(CACHE_DETAIL_PREFIX + quoteId, null);
      if (!response) throw new Error("오프라인에 저장된 상세 견적이 없습니다.");
      setDetail(response);
      setDraft(draftFromQuote(response));
      setPricing(response.pos && response.pos.pricing);
      writeCache(CACHE_DETAIL_PREFIX + quoteId, response);
      return response;
    }

    async function openQuote(quoteId) {
      setBusy(true);
      setError("");
      try {
        await loadQuoteDetail(quoteId);
      } catch (loadError) {
        setError(loadError.message);
      } finally {
        setBusy(false);
      }
    }

    function updateItem(itemId, fieldName, value) {
      setDraft(function (current) {
        return Object.assign({}, current, {
          items: current.items.map(function (item) {
            return item.id === itemId
              ? Object.assign({}, item, (function () {
                  var patch = {};
                  patch[fieldName] = value;
                  return patch;
                })())
              : item;
          }),
        });
      });
    }

    function applyWriteResponse(response) {
      var responsePos = Object.assign({}, response.pos || {});
      if (response.state) responsePos.state = response.state;
      if (response.customer) responsePos.customer = response.customer;
      if (response.pricing) responsePos.pricing = response.pricing;
      var nextDetail = response.quote
        ? Object.assign({}, detail, {
            quote: response.quote,
            pos: Object.assign({}, detail.pos || {}, responsePos),
          })
        : Object.assign({}, detail, {
            pos: Object.assign({}, detail.pos || {}, responsePos),
          });
      setDetail(nextDetail);
      setDraft(draftFromQuote(nextDetail));
      var nextPricing =
        (response.pos && response.pos.pricing) || response.pricing || pricing;
      setPricing(nextPricing);
      writeCache(CACHE_DETAIL_PREFIX + (nextDetail.quote || nextDetail).id, nextDetail);
    }

    async function writeQuote(action, path, confirmMessage) {
      if (action === "finalize") {
        confirmMessage = "준비 수량 기준으로 내부 견적을 확정할까요? 이 단계에서는 고객에게 공개되지 않습니다.";
      }
      if (action === "publish") {
        confirmMessage = "확정된 최신 견적서와 PDF를 고객에게 공개할까요?";
      }
      if (confirmMessage && !global.confirm(confirmMessage)) return;
      setBusy(true);
      setError("");
      try {
        var quote = detail.quote || detail;
        var response = await deviceWriteRequest(
          "/pors/quotes/" + encodeURIComponent(quote.id) + path,
          {
            method: action === "picking" ? "PUT" : "POST",
            body: buildWritePayload(detail, draft, action),
          }
        );
        applyWriteResponse(response);
        if (action === "finalize" || action === "publish") await loadQuotes();
      } catch (writeError) {
        if (writeError.status === 409) {
          try {
            await loadQuoteDetail(quote.id);
            setError("다른 기기에서 먼저 수정했습니다. 최신 견적을 불러왔으니 내용을 다시 확인해 주세요.");
          } catch (reloadError) {
            setError("다른 기기에서 먼저 수정했습니다. 최신 견적을 불러오지 못했습니다: " + reloadError.message);
          }
        } else {
          setError(writeError.message);
        }
      } finally {
        setBusy(false);
      }
    }

    async function linkExistingReceipt(sale) {
      if (!detail) return;
      setBusy(true);
      setError("");
      try {
        var quote = detail.quote || detail;
        var response = await deviceWriteRequest(
          "/pors/quotes/" + encodeURIComponent(quote.id) + "/receipt-link",
          {
            method: "POST",
            body: buildReceiptLinkPayload(detail, sale),
          }
        );
        applyWriteResponse(response);
        await loadQuotes();
      } catch (linkError) {
        if (linkError.status === 409) {
          try {
            await loadQuoteDetail(quote.id);
            setError("다른 기기에서 먼저 변경했습니다. 최신 견적을 불러왔으니 내용을 다시 확인해 주세요.");
          } catch (reloadError) {
            setError("다른 기기에서 먼저 변경했습니다. 최신 견적을 불러오지 못했습니다: " + reloadError.message);
          }
        } else {
          setError(linkError.message);
        }
      } finally {
        setBusy(false);
      }
    }

    if (detail && draft) {
      return h(QuoteDetail, {
        canWrite: canWrite,
        detail: detail,
        draft: draft,
        pricing: pricing || {},
        online: online,
        busy: busy,
        error: error,
        sales: props.sales || [],
        onBack: function () {
          setDetail(null);
          setDraft(null);
          setError("");
        },
        onItemChange: updateItem,
        onSavePicking: function () {
          writeQuote("picking", "/picking");
        },
        onPreview: function () {
          writeQuote("preview", "/price-preview");
        },
        onFinalize: function () {
          writeQuote(
            "finalize",
            "/finalize",
            "이 견적을 확정하고 고객에게 최종 가격과 새 문서를 공개할까요? 매출·주문·결제·재고는 생성되지 않습니다."
          );
        },
        onPublish: function () {
          writeQuote("publish", "/publish");
        },
        onLinkReceipt: linkExistingReceipt,
      });
    }
    return h(QuoteList, {
      quotes: quotes,
      online: online,
      busy: busy,
      error: error,
      onOpen: openQuote,
      onReload: loadQuotes,
    });
  }

  global.PorsOnlineQuotes = {
    Screen: OnlineQuotesScreen,
    core: {
      buildWritePayload: buildWritePayload,
      buildReceiptLinkPayload: buildReceiptLinkPayload,
      draftFromQuote: draftFromQuote,
      groupPriceBands: groupPriceBands,
      optionPairs: optionPairs,
      quoteItemsFromDetail: quoteItemsFromDetail,
      resolveItemImage: resolveItemImage,
      requestedQuantityFromDetail: requestedQuantityFromDetail,
      quoteListQuantity: quoteListQuantity,
      webBuyerLabel: webBuyerLabel,
    },
  };
})(window);
