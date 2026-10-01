import { useRef, useState } from "react";
import "./App.css";

const sampleConversation = `Customer: Two meals tomorrow. One must have no peanuts. Deliver after six.

Owner: Confirmed.

Customer later: Make that three. The extra meal is for my grandmother; she needs soft food.

Delivery helper: There are two addresses in this conversation. Which one is current?

Kitchen helper: The order sheet still says two. Has the allergy instruction been confirmed?`;

function fieldLabel(status) {
  if (status === "human_confirmed") {
    return "✓ Human confirmed";
  }

  if (status === "needs_confirmation") {
    return "⚠ Needs confirmation";
  }

  if (status === "missing") {
    return "Not specified";
  }

  return "✓ AI extracted";
}

function formatChange(change) {
  if (typeof change === "string") {
    return change;
  }

  if (!change) {
    return "Order update detected.";
  }

  const field = change.field
    ? change.field.replaceAll("_", " ")
    : "Order";

  const oldValue = change.old_value ?? "previous value";
  const newValue = change.new_value ?? "new value";

  const reason = change.reason
    ? ` — ${change.reason}`
    : "";

  return `${field}: ${oldValue} → ${newValue}${reason}`;
}

function getStatusText(status) {
  if (status === "BLOCKED") {
    return "Blocked — critical confirmation required";
  }

  if (status === "NEEDS_CONFIRMATION") {
    return "Needs confirmation";
  }

  return "Ready for preparation";
}

function getStatusClass(status) {
  if (status === "BLOCKED") {
    return "status-blocked";
  }

  if (status === "NEEDS_CONFIRMATION") {
    return "status-warning";
  }

  return "status-ready";
}

function App() {
  // --------------------------------------------------
  // MULTIPLE ORDERS
  // --------------------------------------------------

  const [orders, setOrders] = useState([
    {
      id: 1024,
      customerName: "",
      conversation: sampleConversation,
      order: null,
      history: [],
    },
  ]);

  const [activeOrderId, setActiveOrderId] = useState(1024);

  const activeOrder =
    orders.find((item) => item.id === activeOrderId) ||
    orders[0];

  // --------------------------------------------------
  // UI STATE
  // --------------------------------------------------

  const [loading, setLoading] = useState(false);

  const [mediaLoading, setMediaLoading] =
    useState(false);

  const [error, setError] = useState("");

  const [mediaLabel, setMediaLabel] =
    useState("");

  const [resolvingIssue, setResolvingIssue] =
    useState(null);

  const [resolution, setResolution] =
    useState("");

  const imageInputRef = useRef(null);
  const voiceInputRef = useRef(null);

  // --------------------------------------------------
  // ORDER MANAGEMENT
  // --------------------------------------------------

  function createNewOrder() {
    const highestId = Math.max(
      ...orders.map((item) => item.id)
    );

    const newOrder = {
      id: highestId + 1,
      customerName: "",
      conversation: "",
      order: null,
      history: [],
    };

    setOrders((previous) => [
      ...previous,
      newOrder,
    ]);

    setActiveOrderId(newOrder.id);

    setError("");
    setMediaLabel("");
    setResolvingIssue(null);
    setResolution("");
  }

  function switchOrder(orderId) {
    setActiveOrderId(orderId);

    setError("");
    setMediaLabel("");
    setResolvingIssue(null);
    setResolution("");
  }

  function updateCustomerName(value) {
    setOrders((previous) =>
      previous.map((item) =>
        item.id === activeOrderId
          ? {
              ...item,
              customerName: value,
            }
          : item
      )
    );
  }

  function updateConversation(value) {
    setOrders((previous) =>
      previous.map((item) =>
        item.id === activeOrderId
          ? {
              ...item,
              conversation: value,
            }
          : item
      )
    );
  }

  // --------------------------------------------------
  // FILE HELPERS
  // --------------------------------------------------

  async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(
            new Error("Could not read the file.")
          );
          return;
        }

        resolve(reader.result);
      };

      reader.onerror = () => {
        reject(
          new Error("Failed to read the file.")
        );
      };

      reader.readAsDataURL(file);
    });
  }

  async function prepareImage(file) {
    const originalDataUrl =
      await fileToDataUrl(file);

    // Small images stay untouched.
    if (file.size <= 8 * 1024 * 1024) {
      return {
        data: originalDataUrl.split(",")[1],
        mimeType: file.type,
      };
    }

    const image = new Image();

    image.src = originalDataUrl;

    if (image.decode) {
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;

        image.onerror = () =>
          reject(
            new Error(
              "Could not decode the image."
            )
          );
      });
    }

    const maxDimension = 1800;

    const scale = Math.min(
      1,
      maxDimension /
        Math.max(
          image.width,
          image.height
        )
    );

    const canvas =
      document.createElement("canvas");

    canvas.width = Math.max(
      1,
      Math.round(
        image.width * scale
      )
    );

    canvas.height = Math.max(
      1,
      Math.round(
        image.height * scale
      )
    );

    const ctx =
      canvas.getContext("2d");

    if (!ctx) {
      throw new Error(
        "Could not prepare the image."
      );
    }

    ctx.drawImage(
      image,
      0,
      0,
      canvas.width,
      canvas.height
    );

    let quality = 0.9;

    let blob = await new Promise(
      (resolve) =>
        canvas.toBlob(
          resolve,
          "image/jpeg",
          quality
        )
    );

    if (!blob) {
      throw new Error(
        "Could not compress the image."
      );
    }

    while (
      blob.size >
        12 * 1024 * 1024 &&
      quality > 0.6
    ) {
      quality -= 0.1;

      blob = await new Promise(
        (resolve) =>
          canvas.toBlob(
            resolve,
            "image/jpeg",
            quality
          )
      );

      if (!blob) {
        throw new Error(
          "Could not compress the image."
        );
      }
    }

    if (
      blob.size >
      12 * 1024 * 1024
    ) {
      throw new Error(
        "This image is too large even after compression."
      );
    }

    const compressedDataUrl =
      await fileToDataUrl(blob);

    return {
      data:
        compressedDataUrl.split(",")[1],
      mimeType: "image/jpeg",
    };
  }

  // --------------------------------------------------
  // HISTORY
  // --------------------------------------------------

  function addHistoryEntry(
    orderId,
    source,
    result
  ) {
    const entry = {
      id: `${Date.now()}-${Math.random()}`,

      source,

      time: new Date().toLocaleTimeString(
        [],
        {
          hour: "2-digit",
          minute: "2-digit",
        }
      ),

      status: result.status,

      summary:
        result.changes?.length > 0
          ? formatChange(
              result.changes[
                result.changes.length - 1
              ]
            )
          : result.status === "READY"
            ? "Order state confirmed with no unresolved issues."
            : "Order state updated; confirmation is still required.",
    };

    setOrders((previous) =>
      previous.map((item) =>
        item.id === orderId
          ? {
              ...item,
              history: [
                ...item.history,
                entry,
              ],
            }
          : item
      )
    );
  }

  // --------------------------------------------------
  // GEMINI ANALYSIS
  // --------------------------------------------------

  async function analyzeOrder(options = {}) {
    const {
      customConversation,
      media = null,
      source = "Text conversation",
    } = options;

    const currentConversation =
      customConversation !== undefined
        ? customConversation
        : activeOrder.conversation;

    const currentOrderState =
      activeOrder.order;

    if (
      !currentConversation?.trim() &&
      !media
    ) {
      setError(
        "Add a conversation or upload an image/voice note first."
      );

      return;
    }

    setLoading(!media);
    setMediaLoading(Boolean(media));
    setError("");

    try {
      const response = await fetch(
        "http://localhost:3001/api/analyze",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            conversation:
              currentConversation,

            currentOrder:
              currentOrderState,

            media,
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Analysis failed."
        );
      }

      // Save conversation + order state
      // ONLY to the active order.
      setOrders((previous) =>
        previous.map((item) =>
          item.id === activeOrderId
            ? {
                ...item,
                conversation:
                  currentConversation,
                order: data,
              }
            : item
        )
      );

      addHistoryEntry(
        activeOrderId,
        source,
        data
      );
    } catch (err) {
      console.error(err);

      setError(
        err.message ||
          "Failed to analyze the order."
      );
    } finally {
      setLoading(false);
      setMediaLoading(false);
    }
  }

  // --------------------------------------------------
  // IMAGE UPLOAD
  // --------------------------------------------------

  async function handleImageUpload(
    event
  ) {
    const file =
      event.target.files?.[0];

    if (!file) {
      return;
    }

    if (
      !file.type.startsWith("image/")
    ) {
      setError(
        "Please select an image file."
      );

      event.target.value = "";
      return;
    }

    try {
      setError("");

      setMediaLabel(
        `📷 ${file.name}`
      );

      const prepared =
        await prepareImage(file);

      await analyzeOrder({
        media: {
          type: "image",
          data: prepared.data,
          mimeType:
            prepared.mimeType,
          name: file.name,
        },

        source:
          `Image · ${file.name}`,
      });
    } catch (err) {
      console.error(err);

      setError(
        err.message ||
          "Could not prepare the image."
      );

      setMediaLabel("");
    } finally {
      event.target.value = "";
    }
  }

  // --------------------------------------------------
  // VOICE UPLOAD
  // --------------------------------------------------

  async function handleVoiceUpload(
    event
  ) {
    const file =
      event.target.files?.[0];

    if (!file) {
      return;
    }

    if (
      !file.type.startsWith("audio/")
    ) {
      setError(
        "Please select an audio file."
      );

      event.target.value = "";
      return;
    }

    if (
      file.size >
      12 * 1024 * 1024
    ) {
      setError(
        "Please choose a voice note under 12 MB."
      );

      event.target.value = "";
      return;
    }

    try {
      setError("");

      setMediaLabel(
        `🎙️ ${file.name}`
      );

      const dataUrl =
        await fileToDataUrl(file);

      const base64 =
        dataUrl.split(",")[1];

      await analyzeOrder({
        media: {
          type: "audio",
          data: base64,
          mimeType: file.type,
          name: file.name,
        },

        source:
          `Voice · ${file.name}`,
      });
    } catch (err) {
      console.error(err);

      setError(
        err.message ||
          "Could not prepare the voice note."
      );

      setMediaLabel("");
    } finally {
      event.target.value = "";
    }
  }

  // --------------------------------------------------
  // RESOLVE
  // --------------------------------------------------

  function openResolve(
    issue,
    index
  ) {
    setResolvingIssue({
      issue,
      index,
    });

    setResolution("");
    setError("");
  }

  function closeResolve() {
    setResolvingIssue(null);
    setResolution("");
  }

  async function confirmResolution() {
    if (
      !resolvingIssue ||
      !resolution.trim()
    ) {
      return;
    }

    const updatedConversation =
      `${activeOrder.conversation}

Kitchen worker confirmation:
The previously unresolved issue was:
"${resolvingIssue.issue}"

Human-confirmed resolution:
${resolution.trim()}

This human confirmation is authoritative. Use it as the latest confirmed information.`;

    // Save the confirmation ONLY
    // inside the current order.
    setOrders((previous) =>
      previous.map((item) =>
        item.id === activeOrderId
          ? {
              ...item,
              conversation:
                updatedConversation,
            }
          : item
      )
    );

    closeResolve();

    await analyzeOrder({
      customConversation:
        updatedConversation,

      source:
        "Kitchen worker confirmation",
    });
  }

  // --------------------------------------------------
  // RENDER
  // --------------------------------------------------

  const orderData = activeOrder.order;

  const fieldStatus =
    orderData?.field_status || {};

  return (
    <div className="app">

      {/* -------------------------------------------- */}
      {/* TOP BAR */}
      {/* -------------------------------------------- */}

      <header className="topbar">

        <div>
          <div className="logo">
            OrderSync AI
          </div>

          <div className="subtitle">
            Turn messy customer conversations
            into reliable orders
          </div>
        </div>

        <div className="status">
          <span className="status-dot"></span>

          AI Prototype
        </div>

      </header>

      <main className="container">

        {/* ------------------------------------------ */}
        {/* HERO */}
        {/* ------------------------------------------ */}

        <section className="hero">

          <div className="eyebrow">
            MULTIMODAL ORDER RECONCILIATION
          </div>

          <h1>
            The order hidden in the conversation.
          </h1>

          <p>
            Combine messages, voice notes,
            and photos into one evolving order.
            OrderSync tracks what changed,
            separates critical requirements
            from ordinary preferences, and
            refuses to guess when a human
            decision is needed.
          </p>

        </section>

        {/* ------------------------------------------ */}
        {/* ORDER MANAGER */}
        {/* ------------------------------------------ */}

        <div className="order-manager">

          <div className="order-tabs">

            {orders.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`order-tab ${
                  item.id ===
                  activeOrderId
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  switchOrder(
                    item.id
                  )
                }
              >
                #{item.id}

                {item.customerName
                  ? ` · ${item.customerName}`
                  : ""}
              </button>
            ))}

          </div>

          <button
            type="button"
            className="new-order-button"
            onClick={
              createNewOrder
            }
          >
            ＋ New Order
          </button>

        </div>

        {/* ------------------------------------------ */}
        {/* CURRENT ORDER INPUT */}
        {/* ------------------------------------------ */}

        <section className="input-card">

          <div className="section-header">

            <div>

              <span className="eyebrow">
                ORDER #{activeOrder.id}
              </span>

              <h2>
                Customer Inputs
              </h2>

              <p>
                Add text, a voice note,
                or an order image. Each
                new input is reconciled
                against this order only.
              </p>

            </div>

          </div>

          <input
            type="text"
            className="customer-name"
            value={
              activeOrder.customerName
            }
            onChange={(e) =>
              updateCustomerName(
                e.target.value
              )
            }
            placeholder="Customer name (optional)"
          />

          <textarea
            value={
              activeOrder.conversation
            }
            onChange={(e) =>
              updateConversation(
                e.target.value
              )
            }
            placeholder="Paste the customer conversation here..."
          />

          <div className="actions">

            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                voiceInputRef.current?.click()
              }
              disabled={
                loading ||
                mediaLoading
              }
            >
              ＋ Upload Voice
            </button>

            <input
              ref={voiceInputRef}
              type="file"
              accept="audio/*"
              onChange={
                handleVoiceUpload
              }
              hidden
            />

            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                imageInputRef.current?.click()
              }
              disabled={
                loading ||
                mediaLoading
              }
            >
              ＋ Upload Image
            </button>

            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              onChange={
                handleImageUpload
              }
              hidden
            />

            <button
              type="button"
              className="primary-button"
              onClick={() =>
                analyzeOrder()
              }
              disabled={
                loading ||
                mediaLoading
              }
            >
              {loading
                ? "Analyzing..."
                : "Analyze Order →"}
            </button>

          </div>

          {mediaLoading && (
            <p className="processing">
              ✦ Gemini is reconciling the
              new media with this order...
            </p>
          )}

          {!mediaLoading &&
            mediaLabel && (
              <p className="upload-success">
                {mediaLabel} analyzed
                successfully.
              </p>
            )}

          {error && (
            <p className="error">
              {error}
            </p>
          )}

        </section>

        {/* ------------------------------------------ */}
        {/* DASHBOARD */}
        {/* ------------------------------------------ */}

        {orderData && (

          <section className="dashboard">

            <div className="dashboard-title">

              <div>

                <span className="eyebrow">
                  ORDER #{activeOrder.id}
                </span>

                <h2>
                  {activeOrder.customerName
                    ? `${activeOrder.customerName}'s Order`
                    : "Current Order"}
                </h2>

              </div>

              <div
                className={`order-status ${getStatusClass(
                  orderData.status
                )}`}
              >

                <span className="status-dot"></span>

                {getStatusText(
                  orderData.status
                )}

              </div>

            </div>

            {/* -------------------------------------- */}
            {/* ORDER CARDS */}
            {/* -------------------------------------- */}

            <div className="order-grid">

              <div className="order-card">

                <span className="label">
                  Meals
                </span>

                <strong>
                  {orderData.quantity ??
                    "—"}
                </strong>

                <span
                  className={
                    fieldStatus.quantity ===
                    "needs_confirmation"
                      ? "warning"
                      : "confirmed"
                  }
                >
                  {fieldLabel(
                    fieldStatus.quantity
                  )}
                </span>

              </div>

              <div className="order-card">

                <span className="label">
                  Delivery
                </span>

                <strong>
                  {orderData.delivery_date ||
                    "—"}
                </strong>

                <span
                  className={
                    fieldStatus.delivery_time ===
                    "needs_confirmation"
                      ? "warning"
                      : "confirmed"
                  }
                >
                  {orderData.delivery_time ||
                    "Time not specified"}
                </span>

                <span className="field-status-small">
                  {fieldLabel(
                    fieldStatus.delivery_time
                  )}
                </span>

              </div>

              <div className="order-card">

                <span className="label">
                  Address
                </span>

                <strong>
                  {orderData.address ||
                    "—"}
                </strong>

                <span
                  className={
                    fieldStatus.address ===
                    "needs_confirmation"
                      ? "warning"
                      : "confirmed"
                  }
                >
                  {fieldLabel(
                    fieldStatus.address
                  )}
                </span>

              </div>

              <div className="order-card">

                <span className="label">
                  Dietary requirements
                </span>

                <strong>
                  {orderData
                    .dietary_restrictions
                    ?.length
                    ? orderData
                        .dietary_restrictions
                        .join(", ")
                    : "None detected"}
                </strong>

                <span
                  className={
                    fieldStatus
                      .dietary_restrictions ===
                    "needs_confirmation"
                      ? "warning"
                      : "confirmed"
                  }
                >
                  {fieldLabel(
                    fieldStatus
                      .dietary_restrictions
                  )}
                </span>

              </div>

              <div className="order-card critical-card">

                <span className="label">
                  Critical requirements
                </span>

                {orderData
                  .critical_requirements
                  ?.length ? (

                  orderData
                    .critical_requirements
                    .map(
                      (
                        item,
                        index
                      ) => (

                        <div
                          className="critical-item"
                          key={index}
                        >

                          <strong>
                            🚨{" "}
                            {item.detail}
                          </strong>

                          <span
                            className={
                              item.status ===
                              "needs_confirmation"
                                ? "warning"
                                : "confirmed"
                            }
                          >
                            {item.status ===
                            "needs_confirmation"
                              ? "⚠ Needs confirmation"
                              : "✓ Human confirmed"}
                          </span>

                        </div>

                      )
                    )

                ) : (

                  <strong>
                    None detected
                  </strong>

                )}

                {orderData.allergies
                  ?.length > 0 && (

                  <span className="warning">
                    Allergies:{" "}
                    {orderData.allergies.join(
                      ", "
                    )}
                  </span>

                )}

              </div>

              <div className="order-card">

                <span className="label">
                  Special requirements
                </span>

                <strong>
                  {orderData
                    .special_requirements
                    ?.length
                    ? orderData
                        .special_requirements
                        .join(", ")
                    : "None detected"}
                </strong>

                <span
                  className={
                    fieldStatus
                      .special_requirements ===
                    "needs_confirmation"
                      ? "warning"
                      : "confirmed"
                  }
                >
                  {fieldLabel(
                    fieldStatus
                      .special_requirements
                  )}
                </span>

              </div>

            </div>

            {/* -------------------------------------- */}
            {/* MEDIA EVIDENCE */}
            {/* -------------------------------------- */}

            {(orderData.media_summary ||
              orderData.media_transcript) && (

              <div className="section-block">

                <h3>
                  Latest Media Evidence
                </h3>

                {orderData.media_summary && (

                  <p>
                    <strong>
                      What AI found:
                    </strong>{" "}
                    {orderData.media_summary}
                  </p>

                )}

                {orderData.media_transcript && (

                  <div className="transcript-box">

                    <span className="label">
                      Voice transcript
                    </span>

                    <p>
                      {orderData.media_transcript}
                    </p>

                  </div>

                )}

              </div>

            )}

            {/* -------------------------------------- */}
            {/* CHANGES */}
            {/* -------------------------------------- */}

            <div className="section-block">

              <h3>
                Changes Detected
              </h3>

              {orderData.changes?.length ? (

                orderData.changes.map(
                  (change, index) => (

                    <div
                      className="change"
                      key={index}
                    >

                      <div className="change-icon">
                        ↗
                      </div>

                      <div>

                        <strong>
                          {change?.field ||
                            "Order modification"}
                        </strong>

                        <p>
                          {formatChange(
                            change
                          )}
                        </p>

                      </div>

                    </div>

                  )
                )

              ) : (

                <p>
                  No changes detected.
                </p>

              )}

            </div>

            {/* -------------------------------------- */}
            {/* NEEDS CONFIRMATION */}
            {/* -------------------------------------- */}

            <div className="section-block">

              <div className="confirmation-header">

                <div>

                  <h3>
                    Needs Confirmation
                  </h3>

                  <p>
                    OrderSync will not silently
                    guess at uncertainty.
                  </p>

                </div>

                <span className="count">
                  {orderData
                    .needs_confirmation
                    ?.length || 0}{" "}
                  issues
                </span>

              </div>

              {orderData
                .needs_confirmation
                ?.length ? (

                orderData
                  .needs_confirmation
                  .map(
                    (
                      issue,
                      index
                    ) => (

                      <div
                        className="issue"
                        key={index}
                      >

                        <div>

                          <strong>
                            ⚠ Confirmation required
                          </strong>

                          <p>
                            {issue}
                          </p>

                        </div>

                        <button
                          type="button"
                          className="resolve-button"
                          onClick={() =>
                            openResolve(
                              issue,
                              index
                            )
                          }
                        >
                          Resolve
                        </button>

                      </div>

                    )
                  )

              ) : (

                <p>
                  No unresolved issues
                  detected.
                </p>

              )}

            </div>

            {/* -------------------------------------- */}
            {/* CONFLICTS */}
            {/* -------------------------------------- */}

            {orderData.conflicts?.length >
              0 && (

              <div className="section-block">

                <h3>
                  Conflicts Detected
                </h3>

                {orderData.conflicts.map(
                  (
                    conflict,
                    index
                  ) => (

                    <div
                      className="issue"
                      key={index}
                    >

                      <div>

                        <strong>
                          ⚠ Conflict
                        </strong>

                        <p>
                          {conflict}
                        </p>

                      </div>

                    </div>

                  )
                )}

              </div>

            )}

            {/* -------------------------------------- */}
            {/* TIMELINE */}
            {/* -------------------------------------- */}

            {activeOrder.history.length >
              0 && (

              <div className="section-block">

                <h3>
                  Order Timeline
                </h3>

                <div className="timeline">

                  {activeOrder.history.map(
                    (entry) => (

                      <div
                        className="timeline-item"
                        key={entry.id}
                      >

                        <div className="timeline-dot"></div>

                        <div className="timeline-content">

                          <div className="timeline-top">

                            <strong>
                              {entry.source}
                            </strong>

                            <span>
                              {entry.time}
                            </span>

                          </div>

                          <p>
                            {entry.summary}
                          </p>

                        </div>

                      </div>

                    )
                  )}

                </div>

              </div>

            )}

          </section>

        )}

      </main>

      {/* -------------------------------------------- */}
      {/* RESOLVE MODAL */}
      {/* -------------------------------------------- */}

      {resolvingIssue && (

        <div className="modal-overlay">

          <div className="resolve-modal">

            <div className="modal-header">

              <div>

                <span className="eyebrow">
                  HUMAN CONFIRMATION
                </span>

                <h2>
                  Resolve Issue
                </h2>

              </div>

              <button
                type="button"
                className="modal-close"
                onClick={
                  closeResolve
                }
              >
                ×
              </button>

            </div>

            <div className="modal-issue">

              <strong>
                AI flagged:
              </strong>

              <p>
                {resolvingIssue.issue}
              </p>

            </div>

            <label className="modal-label">
              Enter the confirmed information
            </label>

            <textarea
              className="resolution-input"
              value={resolution}
              onChange={(e) =>
                setResolution(
                  e.target.value
                )
              }
              placeholder="Example: The correct delivery address is 22 Residency Road."
              autoFocus
            />

            <p className="resolution-help">
              This becomes an authoritative
              kitchen-worker confirmation and
              overrides the conflicting
              information.
            </p>

            <div className="modal-actions">

              <button
                type="button"
                className="secondary-button"
                onClick={
                  closeResolve
                }
              >
                Cancel
              </button>

              <button
                type="button"
                className="primary-button"
                onClick={
                  confirmResolution
                }
                disabled={
                  !resolution.trim() ||
                  loading
                }
              >
                {loading
                  ? "Re-analyzing..."
                  : "Confirm & Re-analyze"}
              </button>

            </div>

          </div>

        </div>

      )}

    </div>
  );
}

export default App;