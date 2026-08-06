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
        var fulfillmentStatus = String(item.fulfillmentStatus || "").toLowerCase();
        return {
          id: item.id,
          preparedQuantity: clampQuantity(prepared, requested),
          preparationMarked:
            prepared > 0 &&
            (fulfillmentStatus === "ready" || fulfillmentStatus === "partial"),
          cancellationReason: item.cancellationReason || "",
          cancellationNote: item.cancellationNote || "",
          itemNote: item.itemNote || "",
        };
      }),
    };
  }

  function pricingFromDetail(detail) {
    var pos = (detail && detail.pos) || {};
    var state = pos.state || {};
    return (
      pos.pricing ||
      (state.finalizedSnapshot && state.finalizedSnapshot.pricing) ||
      state.lastPreview ||
      (state.publishedSnapshot && state.publishedSnapshot.pricing) ||
      null
    );
  }

  function publicationIsCurrent(detail) {
    var pos = (detail && detail.pos) || {};
    var state = pos.state || {};
    var finalizedAt = pos.finalizedAt || state.finalizedAt || "";
    var publishedAt = pos.publishedAt || state.publishedAt || "";
    if (!finalizedAt || !publishedAt) return false;
    var finalizedTime = Date.parse(finalizedAt);
    var publishedTime = Date.parse(publishedAt);
    if (Number.isFinite(finalizedTime) && Number.isFinite(publishedTime)) {
      return publishedTime >= finalizedTime;
    }
    return String(publishedAt) >= String(finalizedAt);
  }

  function requestText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function defaultValidUntil() {
    var date = new Date();
    date.setDate(date.getDate() + 7);
    return date.toISOString().slice(0, 10);
  }

  function validUntilForApi(value) {
    var normalized = requestText(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
      ? normalized
      : defaultValidUntil();
  }

  function documentLocaleForApi(value) {
    var normalized = requestText(value);
    return ["kr", "en", "jp", "zh-TW"].includes(normalized)
      ? normalized
      : "kr";
  }

  function cancellationForApi(reason, note) {
    var normalizedReason = requestText(reason);
    var normalizedNote = requestText(note);
    var reasonByLabel = {
      "품절": "out_of_stock",
      "수량 부족": "quantity_shortage",
      "품질 문제": "quality_issue",
      "단종": "discontinued",
      "기타": "other",
    };
    var validReasons = [
      "out_of_stock",
      "quantity_shortage",
      "quality_issue",
      "discontinued",
      "other",
    ];
    if (!normalizedReason) {
      return { reason: "", note: normalizedNote };
    }
    if (reasonByLabel[normalizedReason]) {
      return { reason: reasonByLabel[normalizedReason], note: normalizedNote };
    }
    if (validReasons.includes(normalizedReason)) {
      return { reason: normalizedReason, note: normalizedNote };
    }
    return {
      reason: "other",
      note: normalizedNote || normalizedReason,
    };
  }

  function quoteWriteMetadata(detail) {
    var quote = detail && detail.quote ? detail.quote : detail || {};
    return {
      leadTime: requestText(quote.leadTime),
      shippingNote: requestText(quote.shippingNote),
      validUntil: validUntilForApi(quote.validUntil),
      documentLocale: documentLocaleForApi(quote.documentLocale),
      customerNote: requestText(quote.customerNote),
      adminMemo: requestText(quote.adminMemo),
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
      var cancellation = cancellationForApi(
        source.cancellationReason,
        source.cancellationNote
      );
      if (prepared < requested && !cancellation.reason) {
        throw new Error("준비하지 못한 수량에는 취소 사유가 필요합니다.");
      }
      return {
        id: item.id,
        preparedQuantity: prepared,
        cancellationReason: cancellation.reason,
        cancellationNote: cancellation.note,
        itemNote: requestText(source.itemNote),
      };
    });

    return Object.assign({
      expectedVersion:
        Number(detail && detail.pos && detail.pos.state && detail.pos.state.version) ||
        1,
      idempotencyKey: makeIdempotencyKey(action),
      items: items,
    }, quoteWriteMetadata(detail));
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

  function quoteReceiptLines(pricing, items) {
    var itemsById = {};
    (items || []).forEach(function (item) {
      if (item && item.id != null) itemsById[String(item.id)] = item;
    });

    var pricedLines = (pricing && pricing.lines) || [];
    if (pricedLines.length) {
      return pricedLines
        .filter(function (line) {
          return Number(line.preparedQuantity || line.quantity || 0) > 0;
        })
        .map(function (line, index) {
          var item = itemsById[String(line.itemId || line.id)] || {};
          var quantity = Number(line.preparedQuantity || line.quantity || 0);
          var unitPrice = asMoney(line.unitPrice || line.baseUnitPrice);
          return {
            id: String(line.itemId || line.id || index),
            name: item.productName || item.name || item.productCode || item.code || "상품",
            quantity: quantity,
            unitPrice: unitPrice,
            subtotal:
              line.lineSubtotal == null
                ? asMoney(unitPrice * quantity)
                : asMoney(line.lineSubtotal),
          };
        });
    }

    return groupPriceBands(pricing).map(function (band, index) {
      return {
        id: "band:" + index + ":" + band.unitPrice,
        name: "상품",
        quantity: Number(band.quantity || 0),
        unitPrice: asMoney(band.unitPrice),
        subtotal: asMoney(band.unitPrice * band.quantity),
      };
    });
  }

  function buildPrintableReceipt(detail, pricing) {
    var quote = (detail && (detail.quote || detail)) || {};
    var pos = (detail && detail.pos) || {};
    var state = pos.state || {};
    var lines = quoteReceiptLines(
      pricing,
      quoteItemsFromDetail(detail)
    ).map(function (line) {
      return {
        id: line.id,
        name: line.name,
        quantity: line.quantity,
        price: line.unitPrice,
      };
    });
    return {
      id: "online_quote_" + String(quote.id || quote.quoteNumber || Date.now()),
      createdAt: pos.finalizedAt || state.finalizedAt || new Date().toISOString(),
      customerId: null,
      customerName: quote.companyName || quote.buyerCompany || "웹 견적",
      writerName: "웹 견적",
      customerNote: "",
      lines: lines,
      deduction: { amount: 0, taxIncluded: false },
      totals: {
        subtotal: asMoney(pricing && pricing.subtotal),
        discount: 0,
        shippingFee: 0,
        supply: asMoney(pricing && pricing.supplyAmount),
        vat: asMoney(pricing && pricing.vatAmount),
        total: asMoney(pricing && pricing.totalAmount),
        deduction: 0,
        deductionTaxIncluded: false,
      },
    };
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

  function apiErrorMessage(payload, fallback) {
    if (typeof payload === "string") {
      return payload.trim() || fallback;
    }
    if (!payload || typeof payload !== "object") return fallback;

    var candidates = [
      payload.message,
      payload.error,
      payload.detail,
      payload.reason,
    ];
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      if (candidate && typeof candidate === "object" && typeof candidate.message === "string" && candidate.message.trim()) {
        return candidate.message.trim();
      }
    }
    return fallback;
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
        apiErrorMessage(payload, "웹 견적을 불러오지 못했습니다.")
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
        apiErrorMessage(payload, "웹 견적 작업에 실패했습니다.")
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
    var quantity = Number(props.requestedQuantity);
    if (Number.isFinite(quantity) && quantity >= 0) {
      var quantityIndex = pairs.length;
      for (var index = 0; index < pairs.length; index += 1) {
        if (pairs[index].label === "색상") {
          quantityIndex = index + 1;
          break;
        }
      }
      pairs.splice(quantityIndex, 0, { label: "갯수", value: quantity + "개" });
    }
    if (!pairs.length) return null;
    var preparationMarked = Boolean(props.preparationMarked);
    return h(
      "dl",
      { className: "online-quote-options" },
      pairs.map(function (pair, index) {
        return h(
          "div",
          { key: pair.label + ":" + pair.value + ":" + index, className: "online-quote-options__pair" },
          h("dt", null, pair.label),
          h("dd", null, pair.value)
        );
      }),
      h(
        "div",
        {
          className: "online-quote-options__status " +
            (preparationMarked ? "is-active" : "is-inactive"),
          "aria-label": preparationMarked ? "준비 선택됨" : "준비 미선택",
        },
        h("span", null, "준비"),
        h("i", { "aria-hidden": "true" })
      )
    );
  }

  function QuoteItem(props) {
    var item = props.item;
    var requested = Number(item.requestedQuantity || item.quantity || 0);
    var draft = props.draft;
    var image = resolveItemImage(item);
    var prepared = clampQuantity(draft.preparedQuantity, requested);
    var cancelled = requested - prepared;
    var canWrite = props.online && props.canWrite && !props.busy;
    var soldOut = prepared === 0 && draft.cancellationReason === "품절";
    var partiallyPrepared = prepared > 0 && prepared < requested;

    function selectPreparation(patch) {
      if (typeof props.onPreparationSelected === "function") {
        props.onPreparationSelected(patch);
        return;
      }
      Object.keys(patch).forEach(function (fieldName) {
        props.onChange(fieldName, patch[fieldName]);
      });
    }

    function setFullyPrepared() {
      selectPreparation({
        preparedQuantity: requested,
        preparationMarked: true,
        cancellationReason: "",
        cancellationNote: "",
      });
    }

    function setPartiallyPrepared() {
      if (partiallyPrepared) {
        selectPreparation({
          preparationMarked: true,
          cancellationReason:
            !draft.cancellationReason || draft.cancellationReason === "품절"
              ? "수량 부족"
              : draft.cancellationReason,
        });
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
      selectPreparation({
        preparedQuantity: partialQuantity,
        preparationMarked: true,
        cancellationReason: "수량 부족",
      });
    }

    function setSoldOut() {
      selectPreparation({
        preparedQuantity: 0,
        preparationMarked: false,
        cancellationReason: "품절",
        cancellationNote: "",
      });
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
          h(OptionList, {
            item: item,
            requestedQuantity: requested,
            preparationMarked: draft.preparationMarked,
          })
        )
      ),
      h(
        "div",
        { className: "online-quote-item__picking" },
        h(
          "div",
          { className: "online-quote-prepared-control" },
          h("span", null, "준비 수량"),
          h(
            "div",
            { className: "online-quote-quantity-stepper" },
            h(
              "button",
              {
                type: "button",
                "aria-label": "준비 수량 1개 줄이기",
                disabled: !canWrite || soldOut || prepared <= 0,
                onClick: function () {
                  props.onChange("preparedQuantity", prepared - 1);
                  props.onChange("preparationMarked", false);
                },
              },
              "−"
            ),
            h("input", {
              type: "text",
              inputMode: "numeric",
              pattern: "[0-9]*",
              "aria-label": "준비 수량",
              value: prepared,
              disabled: !canWrite || soldOut,
              onChange: function (event) {
                props.onChange("preparedQuantity", clampQuantity(event.target.value, requested));
                props.onChange("preparationMarked", false);
              },
            }),
            h(
              "button",
              {
                type: "button",
                "aria-label": "준비 수량 1개 늘리기",
                disabled: !canWrite || soldOut || prepared >= requested,
                onClick: function () {
                  props.onChange("preparedQuantity", prepared + 1);
                  props.onChange("preparationMarked", false);
                },
              },
              "+"
            )
          )
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
    var receiptLines = quoteReceiptLines(pricing, props.items);
    return h(
      "aside",
      { className: "online-quote-price-summary" },
      h(
        "header",
        { className: "online-quote-receipt__store" },
        h("strong", null, props.storeName || "매장")
      ),
      h(
        "div",
        { className: "online-quote-receipt__lines" },
        h(
          "div",
          { className: "online-quote-receipt__columns" },
          h("span", null, "품목"),
          h("span", null, "수량"),
          h("span", null, "단가"),
          h("span", null, "금액")
        ),
        receiptLines.length
          ? receiptLines.map(function (line) {
              return h(
                "div",
                { key: line.id, className: "online-quote-receipt__line" },
                h("strong", null, line.name),
                h("span", null, line.quantity + "개"),
                h("span", null, formatMoney(line.unitPrice)),
                h("b", null, formatMoney(line.subtotal))
              );
            })
          : h("p", { className: "online-quote-receipt__empty" }, "준비 수량을 계산하면 표시됩니다.")
      ),
      h(
        "dl",
        { className: "online-quote-receipt__totals" },
        h("div", null, h("dt", null, "상품 합계"), h("dd", null, formatMoney(pricing.subtotal))),
        h("div", null, h("dt", null, "공급가액"), h("dd", null, formatMoney(pricing.supplyAmount))),
        h("div", null, h("dt", null, "VAT"), h("dd", null, formatMoney(pricing.vatAmount))),
        h("div", { className: "online-quote-price-summary__total" },
          h("dt", null, "총액"),
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
    var published = publicationIsCurrent(detail);

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
            busy: props.busy,
            finalized: finalized,
            onChange: function (fieldName, value) {
              props.onItemChange(item.id, fieldName, value);
            },
            onPreparationSelected: function (patch) {
              props.onPreparationSelected(item.id, patch);
            },
          });
        })
      ),
      h(PriceSummary, {
        pricing: props.pricing,
        items: quoteItems,
        storeName: quote.companyName || quote.buyerCompany || "매장",
      }),
      h(
        "div",
        { className: "online-quote-action-bar" },
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || !props.canWrite || props.busy || (finalized && !props.dirty) || !features().picking,
            onClick: props.onSavePicking,
          },
          "임시 저장"
        ),
        h(
          "button",
          {
            type: "button",
            className: "online-quotes-primary",
            disabled: !props.online || !props.canWrite || props.busy || (finalized && !props.dirty) || !features().finalize,
            onClick: props.onFinalize,
          },
          finalized
            ? props.dirty ? "견적 다시 확정" : "견적 확정됨"
            : "견적 확정"
        ),
        h(
          "button",
          {
            type: "button",
            className: "online-quotes-secondary",
            disabled:
              !props.online ||
              !props.canWrite ||
              props.busy ||
              props.dirty ||
              !finalized ||
              !quoteReceiptLines(props.pricing, quoteItems).length ||
              typeof props.onPrintReceipt !== "function",
            onClick: props.onPrintReceipt,
          },
          "영수증 출력"
        ),
        h(
          "button",
          {
            type: "button",
            className: "online-quotes-primary",
            disabled: !props.online || !props.canWrite || props.busy || props.dirty || !finalized || published || !features().publish,
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
    var dirtyHook = React.useState(false);
    var draftDirty = dirtyHook[0];
    var setDraftDirty = dirtyHook[1];
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
      setPricing(pricingFromDetail(response));
      setDraftDirty(false);
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
      setDraftDirty(true);
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

    function applyWriteResponse(response, sourceDraft) {
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
      var sourceItems = {};
      ((sourceDraft || draft).items || []).forEach(function (item) {
        sourceItems[item.id] = item;
      });
      var nextDraft = draftFromQuote(nextDetail);
      nextDraft.items = nextDraft.items.map(function (item) {
        return sourceItems[item.id]
          ? Object.assign({}, item, sourceItems[item.id])
          : item;
      });
      setDraft(nextDraft);
      var nextPricing =
        (response.pos && response.pos.pricing) ||
        response.pricing ||
        pricingFromDetail(nextDetail) ||
        pricing;
      setPricing(nextPricing);
      writeCache(CACHE_DETAIL_PREFIX + (nextDetail.quote || nextDetail).id, nextDetail);
    }

    async function writeQuote(action, path, confirmMessage, draftOverride) {
      if (action === "finalize") {
        confirmMessage = "준비 수량 기준으로 내부 견적을 확정할까요? 이 단계에서는 고객에게 공개되지 않습니다.";
      }
      if (action === "publish") {
        confirmMessage = "확정된 최신 견적서와 PDF를 고객에게 공개할까요?";
      }
      if (confirmMessage && !global.confirm(confirmMessage)) return false;
      setBusy(true);
      setError("");
      try {
        var quote = detail.quote || detail;
        var draftToWrite = draftOverride || draft;
        var response = await deviceWriteRequest(
          "/pors/quotes/" + encodeURIComponent(quote.id) + path,
          {
            method: action === "picking" ? "PUT" : "POST",
            body: buildWritePayload(detail, draftToWrite, action),
          }
        );
        applyWriteResponse(response, draftToWrite);
        if (action !== "preview") setDraftDirty(false);
        if (action === "finalize" || action === "publish") await loadQuotes();
        return true;
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
        return false;
      } finally {
        setBusy(false);
      }
    }

    function previewPreparation(itemId, patch) {
      if (!detail || !draft || busy) return;
      var nextDraft = Object.assign({}, draft, {
        items: draft.items.map(function (item) {
          return item.id === itemId ? Object.assign({}, item, patch) : item;
        }),
      });
      setDraft(nextDraft);
      setDraftDirty(true);
      writeQuote("preview", "/price-preview", "", nextDraft);
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
        dirty: draftDirty,
        online: online,
        busy: busy,
        error: error,
        sales: props.sales || [],
        onBack: function () {
          setDetail(null);
          setDraft(null);
          setDraftDirty(false);
          setError("");
        },
        onItemChange: updateItem,
        onPreparationSelected: previewPreparation,
        onSavePicking: function () {
          writeQuote("picking", "/picking");
        },
        onFinalize: function () {
          writeQuote(
            "finalize",
            "/finalize",
            "이 견적을 확정하고 고객에게 최종 가격과 새 문서를 공개할까요? 매출·주문·결제·재고는 생성되지 않습니다."
          );
        },
        onPrintReceipt: function () {
          if (typeof props.onPrintReceipt === "function") {
            props.onPrintReceipt(buildPrintableReceipt(detail, pricing || {}));
          }
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
      buildPrintableReceipt: buildPrintableReceipt,
      apiErrorMessage: apiErrorMessage,
      draftFromQuote: draftFromQuote,
      pricingFromDetail: pricingFromDetail,
      publicationIsCurrent: publicationIsCurrent,
      quoteWriteMetadata: quoteWriteMetadata,
      groupPriceBands: groupPriceBands,
      optionPairs: optionPairs,
      quoteReceiptLines: quoteReceiptLines,
      quoteItemsFromDetail: quoteItemsFromDetail,
      resolveItemImage: resolveItemImage,
      requestedQuantityFromDetail: requestedQuantityFromDetail,
      quoteListQuantity: quoteListQuantity,
      webBuyerLabel: webBuyerLabel,
    },
  };
})(window);
