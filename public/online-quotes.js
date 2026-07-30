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
    if (Array.isArray(selected)) {
      return selected
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
    }

    if (selected && typeof selected === "object") {
      return Object.keys(selected).map(function (key) {
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

    var legacy = [];
    if (item && (item.selectedColor || item.color)) {
      legacy.push({ label: "색상", value: item.selectedColor || item.color });
    }
    if (item && (item.selectedSize || item.size)) {
      legacy.push({ label: "사이즈", value: item.selectedSize || item.size });
    }
    return legacy;
  }

  function isLinkedCustomer(customer) {
    return Boolean(
      customer &&
        (customer.linked === true ||
          customer.connectionStatus === "linked" ||
          customer.source === "linked")
    );
  }

  function resolveItemImage(item) {
    var imageSet = (item && item.imageSet) || {};
    var gallery =
      imageSet.gallery && imageSet.gallery.length ? imageSet.gallery[0] : null;
    var galleryUrls = (gallery && gallery.urls) || {};
    return (
      (item && (item.imageUrl || item.productImageUrl)) ||
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

  function normalizeCatalogCustomer(customer) {
    return {
      id: String(customer.id),
      name: String(customer.name || "거래처"),
      discountRate: Number(customer.discountRate) || 0,
      vatEnabled: Boolean(customer.vatEnabled),
      overseas: Boolean(customer.offshore || customer.overseas),
      active: customer.active !== false,
      pricingRules: Array.isArray(customer.pricingRules)
        ? customer.pricingRules
        : [],
    };
  }

  function normalizeCatalogItem(item) {
    return {
      id: String(item.id),
      code: String(item.code || item.id),
      name: String(item.name || item.code || "품목"),
      basePrice: asMoney(item.price),
      discountable: item.discountable !== false,
      active: item.active !== false,
      pricingRules:
        item.pricingRules && typeof item.pricingRules === "object"
          ? item.pricingRules
          : {},
    };
  }

  function draftFromQuote(detail) {
    var quote = detail && detail.quote ? detail.quote : detail;
    var items = (quote && quote.items) || [];
    var pricingLines =
      detail &&
      detail.pos &&
      detail.pos.pricing &&
      Array.isArray(detail.pos.pricing.lines)
        ? detail.pos.pricing.lines
        : [];
    var pricingById = {};
    pricingLines.forEach(function (line) {
      pricingById[line.itemId] = line;
    });

    return {
      deductionAmount:
        detail && detail.pos && detail.pos.pricing
          ? asMoney(detail.pos.pricing.deductionAmount)
          : 0,
      items: items.map(function (item) {
        var requested = Number(item.requestedQuantity || item.quantity || 0);
        var prepared =
          item.confirmedQuantity == null
            ? requested
            : Number(item.confirmedQuantity);
        var pricingLine = pricingById[item.id] || {};
        return {
          id: item.id,
          preparedQuantity: clampQuantity(prepared, requested),
          cancellationReason: item.cancellationReason || "",
          cancellationNote: item.cancellationNote || "",
          itemNote: item.itemNote || "",
          overrideUnitPrice:
            pricingLine.overrideUnitPrice == null
              ? ""
              : String(pricingLine.overrideUnitPrice),
          overrideReason: pricingLine.overrideReason || "",
          posItemId: "",
        };
      }),
    };
  }

  function buildWritePayload(detail, draft, action) {
    var quote = detail && detail.quote ? detail.quote : detail;
    var quoteItems = (quote && quote.items) || [];
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
      if (
        source.overrideUnitPrice !== "" &&
        !String(source.overrideReason || "").trim()
      ) {
        throw new Error("품목 단가를 바꾸려면 수정 사유를 입력해야 합니다.");
      }

      var output = {
        id: item.id,
        preparedQuantity: prepared,
        cancellationReason: String(source.cancellationReason || "").trim(),
        cancellationNote: String(source.cancellationNote || "").trim(),
        itemNote: String(source.itemNote || "").trim(),
      };
      if (source.overrideUnitPrice !== "") {
        output.overrideUnitPrice = asMoney(source.overrideUnitPrice);
        output.overrideReason = String(source.overrideReason || "").trim();
      }
      return output;
    });

    return {
      expectedVersion:
        Number(detail && detail.pos && detail.pos.state && detail.pos.state.version) ||
        1,
      idempotencyKey: makeIdempotencyKey(action),
      deductionAmount: Math.max(0, asMoney(draft.deductionAmount)),
      items: items,
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
    return String(
      global.PORS_NOBLESSE_API_BASE_URL || "https://noblesse.web.app/api"
    ).replace(/\/+$/, "");
  }

  function firebaseConfig() {
    var explicit = global.PORS_NOBLESSE_FIREBASE_CONFIG;
    if (explicit && Object.keys(explicit).length) return explicit;
    return global.PIERCE_FIREBASE_CONFIG || {};
  }

  function getNamedAuth() {
    if (!global.firebase || !global.firebase.auth) {
      throw new Error("Firebase Auth를 불러오지 못했습니다.");
    }
    var config = firebaseConfig();
    if (!config || !config.apiKey) {
      throw new Error("온라인 견적용 Firebase 설정이 필요합니다.");
    }
    var apps = global.firebase.apps || [];
    var app = apps.find(function (candidate) {
      return candidate.name === "porsNoblesse";
    });
    if (!app) {
      app = global.firebase.initializeApp(config, "porsNoblesse");
    }
    return app.auth();
  }

  async function request(path, options) {
    var auth = getNamedAuth();
    var user = auth.currentUser;
    if (!user) throw new Error("온라인 견적 관리자 로그인이 필요합니다.");
    var token = await user.getIdToken();
    var response = await global.fetch(apiBase() + path, {
      method: (options && options.method) || "GET",
      headers: Object.assign(
        {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        (options && options.headers) || {}
      ),
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
        payload.error || payload.message || "온라인 견적 요청에 실패했습니다."
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function features() {
    return Object.assign(
      { read: true, picking: true, pricing: true, finalize: true },
      global.PORS_NOBLESSE_FEATURES || {}
    );
  }

  function statusLabel(quote) {
    var state = quote && quote.pos && quote.pos.state;
    if (state && state.finalizedAt) return "견적 확정";
    var status = (quote && (quote.status || quote.adminStatus)) || "requested";
    var labels = {
      requested: "접수",
      reviewing: "확인 중",
      draft: "초안",
      sent: "발행",
      accepted: "승인",
      rejected: "거절",
      cancelled: "취소",
    };
    return labels[status] || status;
  }

  function field(label, control, className) {
    return h(
      "label",
      { className: "online-quote-field " + (className || "") },
      h("span", null, label),
      control
    );
  }

  function OnlineQuoteLogin(props) {
    var emailHook = React.useState("");
    var email = emailHook[0];
    var setEmail = emailHook[1];
    var passwordHook = React.useState("");
    var password = passwordHook[0];
    var setPassword = passwordHook[1];
    var busyHook = React.useState(false);
    var busy = busyHook[0];
    var setBusy = busyHook[1];
    var errorHook = React.useState("");
    var error = errorHook[0];
    var setError = errorHook[1];

    async function submit(event) {
      event.preventDefault();
      setBusy(true);
      setError("");
      try {
        await props.auth.signInWithEmailAndPassword(email.trim(), password);
        setPassword("");
      } catch (signInError) {
        setError(signInError.message || "로그인에 실패했습니다.");
      } finally {
        setBusy(false);
      }
    }

    return h(
      "section",
      { className: "online-quotes-auth" },
      h("div", { className: "online-quotes-auth__panel" },
        h("p", { className: "online-quotes-eyebrow" }, "NOBLESSE"),
        h("h2", null, "온라인 견적 로그인"),
        h("p", null, "Noblesse 관리자 계정으로 로그인하면 견적을 확인할 수 있습니다."),
        h(
          "form",
          { onSubmit: submit },
          field(
            "이메일",
            h("input", {
              type: "email",
              autoComplete: "username",
              value: email,
              onChange: function (event) {
                setEmail(event.target.value);
              },
              required: true,
            })
          ),
          field(
            "비밀번호",
            h("input", {
              type: "password",
              autoComplete: "current-password",
              value: password,
              onChange: function (event) {
                setPassword(event.target.value);
              },
              required: true,
            })
          ),
          error ? h("p", { className: "online-quotes-error" }, error) : null,
          h(
            "button",
            { type: "submit", className: "online-quotes-primary", disabled: busy },
            busy ? "로그인 중..." : "로그인"
          )
        )
      )
    );
  }

  function QuoteList(props) {
    var quotes = props.quotes || [];
    return h(
      "section",
      { className: "online-quotes-list" },
      h(
        "div",
        { className: "online-quotes-heading" },
        h("div", null,
          h("p", { className: "online-quotes-eyebrow" }, "NOBLESSE"),
          h("h2", null, "온라인 견적"),
          h("p", null, "고객 요청을 열어 수량을 확인하고 최종 견적을 확정합니다.")
        ),
        h(
          "div",
          { className: "online-quotes-heading__actions" },
          h(
            "button",
            { type: "button", onClick: props.onSync, disabled: !props.online || props.busy },
            "거래처·품목 동기화"
          ),
          h(
            "button",
            { type: "button", onClick: props.onReload, disabled: props.busy },
            "새로고침"
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
              var customer =
                quote.pos && quote.pos.customer
                  ? quote.pos.customer
                  : { name: quote.companyName || quote.buyerCompany || "미연결 거래처" };
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
                  h("strong", null, customer.name),
                  h("small", null, quote.inquiryNumber || quote.quoteNumber || quote.id)
                ),
                h("span", null, Number(quote.itemCount || (quote.items || []).length || 0) + "품목"),
                h("span", null, pricing ? formatMoney(pricing.totalAmount) : formatMoney(quote.confirmedTotal || quote.requestedTotal)),
                h("span", { className: "online-quote-status" }, statusLabel(quote))
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
    var mappedItemId =
      (props.mapping &&
        ((props.mapping.posItem && props.mapping.posItem.id) ||
          props.mapping.posItemId)) ||
      "";
    var cancelled = requested - clampQuantity(draft.preparedQuantity, requested);
    var canWrite = props.online && !props.finalized;
    return h(
      "article",
      { className: "online-quote-item" },
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
          h("span", null, "준비 ", h("b", null, clampQuantity(draft.preparedQuantity, requested))),
          h("span", null, "취소 ", h("b", null, cancelled))
        ),
        field(
          "준비 수량",
          h("input", {
            type: "number",
            inputMode: "numeric",
            min: 0,
            max: requested,
            value: draft.preparedQuantity,
            disabled: !canWrite,
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
              onClick: function () {
                props.onChange("preparedQuantity", requested);
              },
            },
            "전부 준비"
          ),
          h(
            "button",
            {
              type: "button",
              disabled: !canWrite,
              onClick: function () {
                props.onChange("preparedQuantity", 0);
                if (!draft.cancellationReason) props.onChange("cancellationReason", "품절");
              },
            },
            "품절"
          )
        ),
        cancelled > 0
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
      ),
      h(
        "div",
        { className: "online-quote-item__price" },
        field(
          "견적 단가",
          h("input", {
            type: "number",
            min: 0,
            inputMode: "numeric",
            value: draft.overrideUnitPrice,
            disabled: !canWrite,
            placeholder: "PORS 기준가",
            onChange: function (event) {
              props.onChange("overrideUnitPrice", event.target.value);
            },
          })
        ),
        draft.overrideUnitPrice !== ""
          ? field(
              "단가 수정 사유",
              h("input", {
                value: draft.overrideReason,
                disabled: !canWrite,
                onChange: function (event) {
                  props.onChange("overrideReason", event.target.value);
                },
                placeholder: "이번 견적에만 기록됩니다.",
              })
            )
          : null,
        field(
          "PORS 품목 연결",
          h(
            "select",
            {
              value: mappedItemId,
              disabled: !canWrite || !item.productId,
              onChange: function (event) {
                props.onMap(item.productId, event.target.value);
              },
            },
            h(
              "option",
              { value: "", disabled: Boolean(mappedItemId) },
              mappedItemId ? "연결 품목 선택" : "미매핑 - 사이트 요청 가격"
            ),
            (props.items || [])
              .filter(function (posItem) {
                return posItem.active !== false;
              })
              .map(function (posItem) {
                return h(
                  "option",
                  { key: posItem.id, value: posItem.id },
                  posItem.name + " · " + formatMoney(posItem.price)
                );
              })
          )
        ),
        props.mapping
          ? h(
              "p",
              { className: "online-quote-mapping" },
              "현재 연결: ",
              (props.mapping.posItem && props.mapping.posItem.name) ||
                props.mapping.posItemId
            )
          : h(
              "p",
              {
                className:
                  "online-quote-mapping online-quote-mapping--missing",
              },
              "미매핑: 사이트 요청 가격을 기준가로 사용합니다."
            )
      )
    );
  }

  function PriceSummary(props) {
    var pricing = props.pricing || {};
    return h(
      "aside",
      { className: "online-quote-price-summary" },
      h("div", null,
        h("strong", null, props.customer ? props.customer.name : "일반 거래처"),
        h("span", null, isLinkedCustomer(props.customer) ? "연결됨" : "미연결 · 할인 0%")
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
        h("div", null, h("dt", null, "차감"), h("dd", null, "-" + formatMoney(pricing.deductionAmount))),
        h("div", null, h("dt", null, "할인"), h("dd", null, "-" + formatMoney(pricing.discountAmount))),
        h("div", null, h("dt", null, "공급가"), h("dd", null, formatMoney(pricing.supplyAmount))),
        h("div", null, h("dt", null, "VAT"), h("dd", null, formatMoney(pricing.vatAmount))),
        h("div", { className: "online-quote-price-summary__total" },
          h("dt", null, "최종 합계"),
          h("dd", null, formatMoney(pricing.totalAmount))
        )
      )
    );
  }

  function CustomerLinker(props) {
    var selectedHook = React.useState("");
    var selected = selectedHook[0];
    var setSelected = selectedHook[1];
    var linked = isLinkedCustomer(props.customer);
    return h(
      "details",
      { className: "online-quote-extra" },
      h("summary", null, "거래처 연결·가격 설정"),
      h("div", { className: "online-quote-extra__body" },
        h("p", null, linked ? "현재 연결: " + props.customer.name : "미연결 구매자는 일반 거래처·할인 0%로 계산됩니다."),
        field(
          "기존 거래처",
          h(
            "select",
            {
              value: selected,
              disabled: !props.online,
              onChange: function (event) {
                setSelected(event.target.value);
              },
            },
            h("option", { value: "" }, "거래처 선택"),
            (props.customers || [])
              .filter(function (customer) {
                return customer.active !== false;
              })
              .map(function (customer) {
                return h("option", { key: customer.id, value: customer.id }, customer.name);
              })
          )
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || !selected,
            onClick: function () {
              props.onLink(selected);
            },
          },
          "이 거래처로 연결"
        ),
        linked
          ? h(PermanentDiscount, {
              online: props.online,
              customer: props.customer,
              onSave: props.onSaveDiscount,
            })
          : null
      )
    );
  }

  function PermanentDiscount(props) {
    var rateHook = React.useState(String(props.customer.discountRate || 0));
    var rate = rateHook[0];
    var setRate = rateHook[1];
    return h(
      "div",
      { className: "online-quote-permanent-discount" },
      h("strong", null, "거래처 기본 할인"),
      h("p", null, "저장하면 다음 견적에도 영구 적용됩니다."),
      field(
        "할인율(%)",
        h("input", {
          type: "number",
          min: 0,
          max: 100,
          value: rate,
          disabled: !props.online,
          onChange: function (event) {
            setRate(event.target.value);
          },
        })
      ),
      h(
        "button",
        {
          type: "button",
          disabled: !props.online,
          onClick: function () {
            if (
              global.confirm(
                "이 할인율을 거래처 기본값으로 영구 저장할까요?"
              )
            ) {
              props.onSave(Number(rate));
            }
          },
        },
        "영구 할인 저장"
      )
    );
  }

  function QuoteDetail(props) {
    var detail = props.detail;
    var quote = detail.quote || detail;
    var itemDrafts = {};
    (props.draft.items || []).forEach(function (item) {
      itemDrafts[item.id] = item;
    });
    var mappingByProductId = {};
    ((detail.pos && detail.pos.productMappings) || []).forEach(function (mapping) {
      mappingByProductId[mapping.productId] = mapping;
    });
    var finalized = Boolean(
      detail.pos &&
        (detail.pos.finalizedAt ||
          (detail.pos.state && detail.pos.state.finalizedAt))
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
          h("p", { className: "online-quotes-eyebrow" }, statusLabel(quote)),
          h("h2", null, quote.quoteNumber || quote.inquiryNumber || "온라인 견적"),
          h("p", null, (detail.pos && detail.pos.customer && detail.pos.customer.name) || quote.companyName || "미연결 거래처")
        ),
        h(
          "button",
          {
            type: "button",
            onClick: function () {
              props.auth.signOut();
            },
          },
          "로그아웃"
        )
      ),
      !props.online
        ? h("p", { className: "online-quotes-offline" }, "오프라인: 저장·가격 계산·확정은 사용할 수 없습니다.")
        : null,
      props.error ? h("p", { className: "online-quotes-error" }, props.error) : null,
      h(CustomerLinker, {
        online: props.online && !finalized,
        customers: props.customers,
        customer: detail.pos && detail.pos.customer,
        onLink: props.onLinkCustomer,
        onSaveDiscount: props.onSaveDiscount,
      }),
      h(
        "div",
        { className: "online-quote-detail__items" },
        (quote.items || []).map(function (item) {
          return h(QuoteItem, {
            key: item.id,
            item: item,
            draft: itemDrafts[item.id] || {
              preparedQuantity: 0,
              cancellationReason: "",
              overrideUnitPrice: "",
              overrideReason: "",
            },
            mapping: mappingByProductId[item.productId],
            items: props.items,
            online: props.online,
            finalized: finalized,
            onMap: props.onMapProduct,
            onChange: function (fieldName, value) {
              props.onItemChange(item.id, fieldName, value);
            },
          });
        })
      ),
      h(
        "details",
        { className: "online-quote-extra" },
        h("summary", null, "가격 추가 설정"),
        h("div", { className: "online-quote-extra__body" },
          field(
            "차감액",
            h("input", {
              type: "number",
              min: 0,
              inputMode: "numeric",
              disabled: !props.online || finalized,
              value: props.draft.deductionAmount,
              onChange: function (event) {
                props.onDraftChange("deductionAmount", event.target.value);
              },
            })
          )
        )
      ),
      h(PriceSummary, {
        pricing: props.pricing,
        customer: detail.pos && detail.pos.customer,
      }),
      h(
        "div",
        { className: "online-quote-action-bar" },
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || props.busy || finalized || !features().picking,
            onClick: props.onSavePicking,
          },
          "임시 저장"
        ),
        h(
          "button",
          {
            type: "button",
            disabled: !props.online || props.busy || finalized || !features().pricing,
            onClick: props.onPreview,
          },
          "가격 다시 계산"
        ),
        h(
          "button",
          {
            type: "button",
            className: "online-quotes-primary",
            disabled: !props.online || props.busy || finalized || !features().finalize,
            onClick: props.onFinalize,
          },
          finalized ? "견적 확정됨" : "견적 확정"
        )
      )
    );
  }

  function OnlineQuotesScreen(props) {
    var authHook = React.useState(null);
    var auth = authHook[0];
    var setAuth = authHook[1];
    var userHook = React.useState(undefined);
    var user = userHook[0];
    var setUser = userHook[1];
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

    React.useEffect(function () {
      var nextAuth;
      try {
        nextAuth = getNamedAuth();
        setAuth(nextAuth);
      } catch (authError) {
        setError(authError.message);
        setUser(null);
        return undefined;
      }
      return nextAuth.onAuthStateChanged(function (nextUser) {
        setUser(nextUser || null);
      });
    }, []);

    React.useEffect(
      function () {
        if (user && features().read) loadQuotes();
      },
      [user, online]
    );

    async function loadQuotes() {
      if (!online) {
        setQuotes(readCache(CACHE_LIST_KEY, []));
        return;
      }
      setBusy(true);
      setError("");
      try {
        var response = await request("/admin/pos/quotes");
        var rows = response.quotes || response.items || [];
        setQuotes(rows);
        writeCache(CACHE_LIST_KEY, rows);
      } catch (loadError) {
        setError(loadError.message);
      } finally {
        setBusy(false);
      }
    }

    async function openQuote(quoteId) {
      setBusy(true);
      setError("");
      try {
        var response = online
          ? await request("/admin/pos/quotes/" + encodeURIComponent(quoteId))
          : readCache(CACHE_DETAIL_PREFIX + quoteId, null);
        if (!response) throw new Error("오프라인에 저장된 상세 견적이 없습니다.");
        setDetail(response);
        setDraft(draftFromQuote(response));
        setPricing(response.pos && response.pos.pricing);
        writeCache(CACHE_DETAIL_PREFIX + quoteId, response);
      } catch (loadError) {
        setError(loadError.message);
      } finally {
        setBusy(false);
      }
    }

    async function syncCatalog() {
      setBusy(true);
      setError("");
      try {
        await request("/admin/pos/catalog-sync", {
          method: "PUT",
          body: {
            sourceVersion: Date.now(),
            customers: (props.customers || []).map(normalizeCatalogCustomer),
            items: (props.items || []).map(normalizeCatalogItem),
          },
        });
        await loadQuotes();
      } catch (syncError) {
        setError(syncError.message);
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
      if (confirmMessage && !global.confirm(confirmMessage)) return;
      setBusy(true);
      setError("");
      try {
        var quote = detail.quote || detail;
        var response = await request(
          "/admin/pos/quotes/" + encodeURIComponent(quote.id) + path,
          {
            method: action === "picking" ? "PUT" : "POST",
            body: buildWritePayload(detail, draft, action),
          }
        );
        applyWriteResponse(response);
        if (action === "finalize") await loadQuotes();
      } catch (writeError) {
        if (writeError.status === 409) {
          setError("다른 기기에서 먼저 수정했습니다. 현재 입력은 유지되므로 새로고침 후 다시 적용해 주세요.");
        } else {
          setError(writeError.message);
        }
      } finally {
        setBusy(false);
      }
    }

    async function linkCustomer(posCustomerId) {
      var quote = detail.quote || detail;
      setBusy(true);
      setError("");
      try {
        await request(
          "/admin/pos/buyers/" + encodeURIComponent(quote.buyerId) + "/link",
          { method: "PUT", body: { posCustomerId: posCustomerId } }
        );
        await openQuote(quote.id);
      } catch (linkError) {
        setError(linkError.message);
      } finally {
        setBusy(false);
      }
    }

    async function savePermanentDiscount(discountRate) {
      var customer = detail.pos && detail.pos.customer;
      if (!customer || !customer.id) return;
      setBusy(true);
      setError("");
      try {
        await request("/admin/pos/customers/" + encodeURIComponent(customer.id), {
          method: "PUT",
          body: {
            discountRate: discountRate,
            confirmPermanentPricing: true,
          },
        });
        if (typeof props.onCustomerUpdated === "function") {
          props.onCustomerUpdated(customer.id, { discountRate: discountRate });
        }
        await openQuote((detail.quote || detail).id);
      } catch (discountError) {
        setError(discountError.message);
      } finally {
        setBusy(false);
      }
    }

    async function linkProduct(productId, posItemId) {
      if (!productId || !posItemId) return;
      setBusy(true);
      setError("");
      try {
        await request(
          "/admin/pos/products/" + encodeURIComponent(productId) + "/link",
          { method: "PUT", body: { posItemId: posItemId } }
        );
        await openQuote((detail.quote || detail).id);
      } catch (linkError) {
        setError(linkError.message);
      } finally {
        setBusy(false);
      }
    }

    if (!React || !h) return null;
    if (user === undefined) {
      return h("div", { className: "online-quotes-loading" }, "온라인 견적을 준비하고 있습니다.");
    }
    if (!user) {
      return auth
        ? h(OnlineQuoteLogin, { auth: auth })
        : h("p", { className: "online-quotes-error" }, error);
    }
    if (detail && draft) {
      return h(QuoteDetail, {
        auth: auth,
        detail: detail,
        draft: draft,
        pricing: pricing || {},
        online: online,
        busy: busy,
        error: error,
        customers: props.customers || [],
        items: props.items || [],
        onBack: function () {
          setDetail(null);
          setDraft(null);
          setError("");
        },
        onItemChange: updateItem,
        onMapProduct: linkProduct,
        onDraftChange: function (fieldName, value) {
          setDraft(function (current) {
            var patch = {};
            patch[fieldName] = value;
            return Object.assign({}, current, patch);
          });
        },
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
        onLinkCustomer: linkCustomer,
        onSaveDiscount: savePermanentDiscount,
      });
    }
    return h(QuoteList, {
      quotes: quotes,
      online: online,
      busy: busy,
      error: error,
      onOpen: openQuote,
      onReload: loadQuotes,
      onSync: syncCatalog,
    });
  }

  global.PorsOnlineQuotes = {
    Screen: OnlineQuotesScreen,
    core: {
      buildWritePayload: buildWritePayload,
      draftFromQuote: draftFromQuote,
      groupPriceBands: groupPriceBands,
      isLinkedCustomer: isLinkedCustomer,
      normalizeCatalogCustomer: normalizeCatalogCustomer,
      normalizeCatalogItem: normalizeCatalogItem,
      optionPairs: optionPairs,
      resolveItemImage: resolveItemImage,
    },
  };
})(window);
