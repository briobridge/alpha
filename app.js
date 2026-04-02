
const STORAGE_KEY = "attendance-manager-state-v4";
const SUPABASE_URL = "https://sjvmyjyynixstbpvyobq.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqdm15anl5bml4c3RicHZ5b2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDQ5MjAsImV4cCI6MjA5MDI4MDkyMH0.Nr4gDXaock13aS-LwqXAWBzmj09yWizxF75gDF6T_Yw";
const REMOTE_STATE_ROW_ID = "team-alpha";
const DEFAULT_LEAVE_REASONS = ["Sick Leave", "Urgent Work", "Personal Leave"];
const DEFAULT_OFF_REASONS = ["Uninformed", "Sick Leave", "Custom"];
const REPORT_FIELDS = [
  { key: "huntingMessagesSent", label: "Hunting Messages Sent" },
  { key: "huntingRequestsSent", label: "Hunting Requests Sent" },
  { key: "postingOnIds", label: "Posting on IDs" },
  { key: "totalIds", label: "Total IDs" },
  { key: "deposit", label: "Deposit" },
  { key: "newPlayers", label: "New Players" }
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const defaultState = createDefaultState();
let state = structuredClone(defaultState);
let currentView = "home";
let activeEmployeeId = null;
let employeeAuthorized = false;
let checkoutMode = false;
let adminAuthorized = false;
let activeAdminSection = "monthly-attendance";
let activeAdminProgressEmployeeId = null;
let syncInFlight = false;
let remotePollHandle = null;
let cloudBackups = [];
let activeMissedCheckoutWarningId = null;

const supabaseClient = window.supabase?.createClient
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const homeView = document.getElementById("home-view");
const employeePage = document.getElementById("employee-page");
const adminPage = document.getElementById("admin-page");
const employeeList = document.getElementById("employee-list");
const progressList = document.getElementById("progress-list");
const employeeCount = document.getElementById("employee-count");
const leaveModal = document.getElementById("leave-modal");
const leaveModalContent = document.getElementById("leave-modal-content");

document.getElementById("open-admin-panel").addEventListener("click", () => {
  currentView = "admin";
  adminAuthorized = false;
  activeAdminSection = "monthly-attendance";
  activeAdminProgressEmployeeId = null;
  renderAll();
});

document.getElementById("close-leave-modal").addEventListener("click", closeLeaveModal);
leaveModal.addEventListener("click", (event) => {
  if (event.target === leaveModal) {
    closeLeaveModal();
  }
});

function renderAll() {
  toggleViews();
  renderHome();
  if (currentView === "employee" && activeEmployeeId) renderEmployeePage(activeEmployeeId);
  if (currentView === "admin") renderAdminPage();
}

function toggleViews() {
  homeView.classList.toggle("hidden", currentView !== "home");
  employeePage.classList.toggle("hidden", currentView !== "employee");
  adminPage.classList.toggle("hidden", currentView !== "admin");
}

function renderHome() {
  employeeCount.textContent = `${state.employees.length} team members`;
  if (!state.employees.length) {
    employeeList.innerHTML = `<div class="empty-state">No employees yet. Open the admin panel to add your team.</div>`;
    progressList.innerHTML = "";
    return;
  }

  employeeList.innerHTML = state.employees.map((employee) => {
    const shift = getShift(employee.shiftId);
    const status = getTodayEmployeeStatus(employee);
    return `
      <article class="employee-card" style="border-left:4px solid ${employee.color};">
        <div class="employee-meta">
          <strong>${escapeHtml(employee.name)}</strong>
          <span>${shift ? `${escapeHtml(shift.name)} - ${formatShiftWindow(shift)}` : "No shift assigned"}</span>
          <span class="status-pill ${status.className}">${status.label}</span>
        </div>
        <button class="employee-open" data-employee-id="${employee.id}">Select Agent</button>
      </article>
    `;
  }).join("");

  employeeList.querySelectorAll("[data-employee-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeEmployeeId = button.dataset.employeeId;
      employeeAuthorized = false;
      checkoutMode = false;
      currentView = "employee";
      renderAll();
    });
  });

  renderStatusOverview();
}

function renderStatusOverview() {
  const today = getTodayKey();
  const buckets = { checkedIn: [], notCheckedIn: [], checkedOut: [], onLeave: [] };
  state.employees.forEach((employee) => {
    const record = getStatusRecordForNow(employee, today);
    if (record.status === "off" || record.status === "leave-approved") buckets.onLeave.push(employee.name);
    else if (record.checkInAt && !record.checkOutAt) buckets.checkedIn.push(employee.name);
    else if (record.checkOutAt) buckets.checkedOut.push(employee.name);
    else buckets.notCheckedIn.push(employee.name);
  });

  const groups = [
    ["Checked In", buckets.checkedIn, "Working now"],
    ["Not Checked In", buckets.notCheckedIn, "Awaiting attendance"],
    ["Checked Out", buckets.checkedOut, "Completed today"],
    ["On Leave / Off", buckets.onLeave, "Approved leave or scheduled off"]
  ];

  progressList.innerHTML = groups.map(([title, items, subtitle]) => `
    <article class="status-card">
      <h3>${title}</h3>
      <p>${subtitle}</p>
      <div class="name-blocks">${items.length ? items.map((item) => `<span class="name-block">${escapeHtml(item)}</span>`).join("") : `<span class="name-block">None</span>`}</div>
    </article>
  `).join("");
}

function renderEmployeePage(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) {
    currentView = "home";
    renderAll();
    return;
  }

  const shift = getShift(employee.shiftId);
  const status = getTodayEmployeeStatus(employee);
  employeePage.innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="section-label">Agent Folder</p>
          <h2>${escapeHtml(employee.name)}</h2>
          <p class="muted-copy">${shift ? `${escapeHtml(shift.name)} - ${formatShiftWindow(shift)}` : "No shift assigned"}</p>
        </div>
        <button id="back-home" class="ghost-button">Back</button>
      </div>
      <div id="employee-content"></div>
    </section>
  `;

  document.getElementById("back-home").addEventListener("click", () => {
    currentView = "home";
    activeEmployeeId = null;
    employeeAuthorized = false;
    checkoutMode = false;
    renderAll();
  });

  if (!employeeAuthorized) renderPinPage(employee);
  else renderAuthorizedEmployeePage(employee);
}

function renderPinPage(employee) {
  const host = document.getElementById("employee-content");
  host.innerHTML = `
    <div class="pin-shell">
      <div class="pin-box">
        <p class="section-label">PIN Access</p>
        <h3>Enter your PIN</h3>
        <form id="pin-form" class="stacked-form">
          <label>PIN<input type="password" id="portal-pin-input" inputmode="numeric" autocomplete="off" required maxlength="4" pattern="\\d{4}" placeholder="1234"></label>
          <button type="submit" class="primary-button">Login</button>
        </form>
        <p id="pin-feedback" class="feedback"></p>
      </div>
    </div>
  `;
  document.getElementById("portal-pin-input").focus();
  document.getElementById("pin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = document.getElementById("portal-pin-input").value.trim();
    const feedback = document.getElementById("pin-feedback");
    if (value !== employee.pin) {
      feedback.textContent = "Incorrect PIN. Please try again.";
      feedback.className = "feedback error";
      return;
    }
    employeeAuthorized = true;
    renderAuthorizedEmployeePage(employee);
  });
}
function renderAuthorizedEmployeePage(employee) {
  const host = document.getElementById("employee-content");
  const activeRecordDateKey = getActivePortalRecordDateKey(employee);
  const record = getDailyRecord(employee.id, activeRecordDateKey);
  const monthlySummary = getMonthlySummary(employee.id);
  const pace = getTargetPace(employee.id);
  const attendanceStats = getAttendanceStats(employee.id);
  const leaveSummary = renderEmployeeLeaveStatus(employee.id);

  host.innerHTML = `
    <div class="agent-page-shell">
      <div class="agent-top-actions">
        <button id="check-in-btn" class="primary-button" ${canCheckIn(record) ? "" : "disabled"}>Check In</button>
        <button id="check-out-btn" class="secondary-button" ${canCheckOut(record) ? "" : "disabled"}>Check Out</button>
        <button id="open-leave-request" class="ghost-button">Leave Request</button>
      </div>
      <div class="employee-dashboard-grid">
      <section class="dashboard-card">
        <h3>${escapeHtml(employee.name)}'s Progress</h3>
        <p class="muted-copy">Only your own data is shown here.</p>
        <p class="calendar-note">Active shift date: ${formatDateLabel(activeRecordDateKey)}</p>
        <div class="metric-grid">
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Check-In</span><strong>${record.checkInAt ? formatDateTime(record.checkInAt) : "--"}</strong></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Check-Out</span><strong>${record.checkOutAt ? formatDateTime(record.checkOutAt) : "--"}</strong></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Player Target</span><strong>${monthlySummary.newPlayers}/${employee.targets.newPlayers}</strong><div class="target-visual"><div><span>Expected</span><strong>${pace.expectedPlayers}</strong></div><div><span>Behind</span><strong>${pace.playersBehind}</strong></div></div></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Deposit Target</span><strong>${formatPlainNumber(monthlySummary.deposit)} / ${formatPlainNumber(employee.targets.deposit)}</strong><div class="target-visual"><div><span>Expected</span><strong>${formatPlainNumber(pace.expectedDeposit)}</strong></div><div><span>Behind</span><strong>${formatPlainNumber(pace.depositBehind)}</strong></div></div></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Projection Players</span><strong>${pace.projectedPlayers}</strong><p>Projected at current pace</p></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Projection Deposit</span><strong>${formatPlainNumber(pace.projectedDeposit)}</strong><p>Projected at current pace</p></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Late</span><strong>${attendanceStats.late}</strong><p>More than 15 minutes late</p></div></article>
          <article class="metric-card"><div class="metric-copy"><span class="section-label">Absents</span><strong>${attendanceStats.absent}</strong><p>Absent days this month</p></div></article>
        </div>
        <div class="dashboard-actions">
          ${checkoutMode ? buildCheckoutSection(record, activeRecordDateKey) : ""}
          <div class="dashboard-card">
            <h4>Leave Status</h4>
            ${leaveSummary}
          </div>
        </div>
      </section>
      </div>
    </div>
    <section class="dashboard-card" style="margin-top:20px;">
      <h3>Monthly Attendance and Progress</h3>
      <p class="muted-copy">Date-wise progress and attendance for the current month.</p>
      ${renderMonthlyReport(employee.id)}
    </section>
  `;

  wireEmployeeActions(employee.id, activeRecordDateKey);
  maybeShowMissedCheckoutWarning(employee.id, activeRecordDateKey);
}

function wireEmployeeActions(employeeId, activeRecordDateKey) {
  const employee = getEmployee(employeeId);
  document.getElementById("check-in-btn").addEventListener("click", () => {
    const dayRecord = ensureDailyRecord(employeeId, activeRecordDateKey);
    if (dayRecord.checkInAt || dayRecord.checkOutAt) {
      return;
    }
    dayRecord.checkInAt = new Date().toISOString();
    dayRecord.checkOutAt = null;
    dayRecord.status = "present";
    dayRecord.offReason = null;
    persistState();
    checkoutMode = false;
    renderAuthorizedEmployeePage(employee);
    renderHome();
  });

  document.getElementById("check-out-btn").addEventListener("click", () => {
    checkoutMode = true;
    renderAuthorizedEmployeePage(employee);
  });

  document.getElementById("open-leave-request").addEventListener("click", () => {
    openLeaveRequestModal(employeeId);
  });
  document.querySelectorAll("[data-edit-leave-request]").forEach((button) => {
    button.addEventListener("click", () => {
      openLeaveRequestModal(employeeId, button.dataset.editLeaveRequest);
    });
  });
  document.querySelectorAll("[data-cancel-leave-request]").forEach((button) => {
    button.addEventListener("click", () => {
      requestLeaveCancellation(employeeId, button.dataset.cancelLeaveRequest);
    });
  });
  document.querySelectorAll("[data-delete-leave-request]").forEach((button) => {
    button.addEventListener("click", () => {
      const requestId = button.dataset.deleteLeaveRequest;
      openConfirmModal({
        title: "Delete Leave Request",
        message: "Delete this leave request permanently?",
        confirmLabel: "Delete Request",
        onConfirm: () => {
          removeLeaveRequest(requestId);
          renderAuthorizedEmployeePage(employee);
        }
      });
    });
  });

  if (checkoutMode && document.getElementById("checkout-report-form")) {
    const updatePreview = () => {
      const liveReport = {};
      REPORT_FIELDS.forEach((field) => {
        liveReport[field.key] = Number(document.getElementById(`report-${field.key}`).value || 0);
      });
      liveReport.totalPlayers = getBaseTotalPlayers(employeeId, activeRecordDateKey) + liveReport.newPlayers;
      document.getElementById("report-preview-text").textContent = buildWhatsAppReport(employee, liveReport, liveReport.totalPlayers, activeRecordDateKey);
    };

    REPORT_FIELDS.forEach((field) => {
      document.getElementById(`report-${field.key}`)?.addEventListener("input", updatePreview);
    });

    document.getElementById("copy-report-message").addEventListener("click", async () => {
      const text = document.getElementById("report-preview-text").textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
    });

    document.getElementById("checkout-report-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const report = {};
      REPORT_FIELDS.forEach((field) => {
        report[field.key] = Number(document.getElementById(`report-${field.key}`).value || 0);
      });
      report.totalPlayers = getBaseTotalPlayers(employeeId, activeRecordDateKey) + report.newPlayers;
      const dayRecord = ensureDailyRecord(employeeId, activeRecordDateKey);
      if (!dayRecord.checkInAt || dayRecord.checkOutAt) {
        return;
      }
      dayRecord.checkOutAt = new Date().toISOString();
      dayRecord.report = report;
      dayRecord.status = "completed";
      persistState();
      checkoutMode = false;
      renderAuthorizedEmployeePage(employee);
      renderHome();
    });
    document.getElementById("cancel-checkout").addEventListener("click", () => {
      checkoutMode = false;
      renderAuthorizedEmployeePage(employee);
    });
  }
}

function openLeaveRequestModal(employeeId, requestId = null) {
  const existingRequest = requestId ? state.leaveRequests.find((request) => request.id === requestId && request.employeeId === employeeId) : null;
  openAppModal(`
    <div>
      <p class="section-label">Leave Request</p>
      <h2>${existingRequest ? "Edit Leave Request" : "Request Leave"}</h2>
      <form id="leave-request-form" class="stacked-form">
        <label>Request Date<input type="date" id="leave-date" value="${existingRequest?.date || getTodayKey()}"></label>
        <label>Reason<select id="leave-reason">${state.leaveReasons.map((reason) => `<option value="${reason}" ${existingRequest?.reason === reason ? "selected" : ""}>${escapeHtml(reason)}</option>`).join("")}</select></label>
        <label>Description<textarea id="leave-description" placeholder="Write the full reason here">${existingRequest?.description || ""}</textarea></label>
        <button type="submit" class="primary-button">${existingRequest ? "Save Leave Request" : "Send Leave Request"}</button>
      </form>
    </div>
  `, () => {
    document.getElementById("leave-request-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const requestDate = document.getElementById("leave-date").value;
      const reason = document.getElementById("leave-reason").value;
      const description = document.getElementById("leave-description").value.trim();
      if (!requestDate || !reason || !description) return;
      const existing = existingRequest || state.leaveRequests.find((request) => request.employeeId === employeeId && request.date === requestDate && request.status === "pending");
      if (existing) {
        existing.date = requestDate;
        existing.reason = reason;
        existing.description = description;
        if (existing.status === "rejected" || existing.status === "approved") {
          existing.status = "pending";
        }
        syncLeaveRequestToRecord(existing);
      } else {
        const newRequest = { id: createId("leave-request"), employeeId, date: requestDate, reason, description, status: "pending", reviewedNote: "" };
        state.leaveRequests.unshift(newRequest);
        syncLeaveRequestToRecord(newRequest);
      }
      persistState();
      closeLeaveModal();
      renderAuthorizedEmployeePage(getEmployee(employeeId));
    });
  });
}

function openAdminLeaveEditModal(requestId) {
  const request = state.leaveRequests.find((entry) => entry.id === requestId);
  if (!request) return;
  openAppModal(`
    <div>
      <p class="section-label">Leave Request</p>
      <h2>Edit Leave Request</h2>
      <form id="admin-leave-edit-form" class="stacked-form">
        <label>Date<input type="date" id="admin-leave-date" value="${request.date}" required></label>
        <label>Reason<select id="admin-leave-reason">${state.leaveReasons.map((reason) => `<option value="${reason}" ${request.reason === reason ? "selected" : ""}>${escapeHtml(reason)}</option>`).join("")}</select></label>
        <label>Description<textarea id="admin-leave-description" placeholder="Write the full reason here">${request.description}</textarea></label>
        <label>Status
          <select id="admin-leave-status">
            <option value="pending" ${request.status === "pending" ? "selected" : ""}>Pending</option>
            <option value="approved" ${request.status === "approved" ? "selected" : ""}>Approved</option>
            <option value="rejected" ${request.status === "rejected" ? "selected" : ""}>Rejected</option>
            <option value="cancel-requested" ${request.status === "cancel-requested" ? "selected" : ""}>Cancel Requested</option>
            <option value="cancelled" ${request.status === "cancelled" ? "selected" : ""}>Cancelled</option>
          </select>
        </label>
        <div class="action-row">
          <button type="submit" class="primary-button">Save Leave</button>
          <button type="button" id="admin-leave-delete" class="danger-button">Delete</button>
        </div>
      </form>
    </div>
  `, () => {
    document.getElementById("admin-leave-edit-form").addEventListener("submit", (event) => {
      event.preventDefault();
      request.date = document.getElementById("admin-leave-date").value;
      request.reason = document.getElementById("admin-leave-reason").value;
      request.description = document.getElementById("admin-leave-description").value.trim();
      request.status = document.getElementById("admin-leave-status").value;
      syncLeaveRequestToRecord(request);
      persistState();
      closeLeaveModal();
      renderAdminPage();
      if (activeEmployeeId === request.employeeId && employeeAuthorized) {
        renderAuthorizedEmployeePage(getEmployee(request.employeeId));
      }
    });
    document.getElementById("admin-leave-delete").addEventListener("click", () => {
      openConfirmModal({
        title: "Delete Leave Request",
        message: "Delete this leave request permanently?",
        confirmLabel: "Delete Request",
        onConfirm: () => {
          removeLeaveRequest(request.id);
          renderAdminPage();
          if (activeEmployeeId === request.employeeId && employeeAuthorized) {
            renderAuthorizedEmployeePage(getEmployee(request.employeeId));
          }
        }
      });
    });
  });
}

function requestLeaveCancellation(employeeId, requestId) {
  const request = state.leaveRequests.find((entry) => entry.id === requestId && entry.employeeId === employeeId);
  if (!request) return;
  request.status = "cancel-requested";
  syncLeaveRequestToRecord(request);
  persistState();
  renderAuthorizedEmployeePage(getEmployee(employeeId));
}

function removeLeaveRequest(requestId) {
  const request = state.leaveRequests.find((entry) => entry.id === requestId);
  if (!request) return;
  clearLeaveRequestFromRecords(request.employeeId, requestId);
  state.leaveRequests = state.leaveRequests.filter((entry) => entry.id !== requestId);
  persistState();
}

function syncLeaveRequestToRecord(request) {
  clearLeaveRequestFromRecords(request.employeeId, request.id);
  const record = ensureDailyRecord(request.employeeId, request.date);
  record.leaveRequest = { ...request };
  if (request.status === "approved") {
    record.status = "leave-approved";
    record.checkInAt = null;
    record.checkOutAt = null;
  } else if (request.status === "cancelled") {
    record.leaveRequest = { ...request };
    if (record.status === "leave-approved") {
      record.status = "absent";
    }
  } else if (record.status === "leave-approved") {
    record.status = "absent";
  }
}

function clearLeaveRequestFromRecords(employeeId, requestId) {
  Object.values(state.records).forEach((recordsByEmployee) => {
    const record = recordsByEmployee?.[employeeId];
    if (record?.leaveRequest?.id === requestId) {
      record.leaveRequest = null;
      if (record.status === "leave-approved") {
        record.status = "absent";
      }
    }
  });
}

function openAppModal(content, binder) {
  leaveModalContent.innerHTML = content;
  leaveModal.classList.remove("hidden");
  leaveModal.setAttribute("aria-hidden", "false");
  if (typeof binder === "function") binder();
}

function openConfirmModal({ title, message, confirmLabel = "Confirm", confirmClass = "danger-button", onConfirm }) {
  openAppModal(`
    <div>
      <p class="section-label">Confirmation</p>
      <h2>${escapeHtml(title)}</h2>
      <p class="muted-copy">${escapeHtml(message)}</p>
      <div class="action-row modal-action-row">
        <button type="button" id="modal-confirm-action" class="${confirmClass}">${escapeHtml(confirmLabel)}</button>
        <button type="button" id="modal-cancel-action" class="ghost-button">Cancel</button>
      </div>
    </div>
  `, () => {
    document.getElementById("modal-confirm-action").addEventListener("click", () => {
      closeLeaveModal();
      onConfirm?.();
    });
    document.getElementById("modal-cancel-action").addEventListener("click", closeLeaveModal);
  });
}

function maybeShowMissedCheckoutWarning(employeeId, activeRecordDateKey) {
  const missed = getLatestMissedCheckoutRecord(employeeId, activeRecordDateKey);
  if (!missed || missed.id === activeMissedCheckoutWarningId) return;
  activeMissedCheckoutWarningId = missed.id;
  openAppModal(`
    <div>
      <p class="section-label">Check-Out Warning</p>
      <h2>Previous shift is still open</h2>
      <p class="muted-copy">You checked in on ${formatDateLabel(missed.date)} but did not check out. Please inform admin so the record can be corrected.</p>
      <div class="action-row modal-action-row">
        <button type="button" id="acknowledge-missed-checkout" class="primary-button">I Understand</button>
      </div>
    </div>
  `, () => {
    document.getElementById("acknowledge-missed-checkout").addEventListener("click", () => {
      const warningRecord = ensureDailyRecord(employeeId, missed.date);
      warningRecord.missedCheckoutAcknowledged = true;
      persistState();
      closeLeaveModal();
    });
  });
}

function closeLeaveModal() {
  leaveModal.classList.add("hidden");
  leaveModal.setAttribute("aria-hidden", "true");
}

function openAgentEditModal(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) return;
  openAppModal(`
    <div>
      <p class="section-label">Agent Settings</p>
      <h2>Edit Agent</h2>
      <form id="agent-edit-form" class="stacked-form">
        <label>Name<input type="text" id="edit-agent-name" value="${escapeHtml(employee.name)}" required></label>
        <label>Shift<select id="edit-agent-shift">${state.shifts.map((shift) => `<option value="${shift.id}" ${shift.id === employee.shiftId ? "selected" : ""}>${escapeHtml(shift.name)} (${formatShiftWindow(shift)})</option>`).join("")}</select></label>
        <label>Agent Color<input type="color" id="edit-agent-color" value="${employee.color}"></label>
        <div class="time-grid">
          <label>Monthly Players Target<input type="number" id="edit-agent-players" min="0" value="${employee.targets.newPlayers}"></label>
          <label>Monthly Deposit Target<input type="number" id="edit-agent-deposit" min="0" value="${employee.targets.deposit}"></label>
        </div>
        <div class="action-row">
          <button type="submit" class="primary-button">Save Changes</button>
          <button type="button" id="cancel-agent-edit" class="ghost-button">Cancel</button>
        </div>
      </form>
    </div>
  `, () => {
    document.getElementById("agent-edit-form").addEventListener("submit", (event) => {
      event.preventDefault();
      employee.name = document.getElementById("edit-agent-name").value.trim() || employee.name;
      employee.shiftId = document.getElementById("edit-agent-shift").value;
      employee.color = document.getElementById("edit-agent-color").value;
      employee.targets.newPlayers = Number(document.getElementById("edit-agent-players").value || 0);
      employee.targets.deposit = Number(document.getElementById("edit-agent-deposit").value || 0);
      persistState();
      closeLeaveModal();
      renderAdminPage();
      renderHome();
    });
    document.getElementById("cancel-agent-edit").addEventListener("click", closeLeaveModal);
  });
}

function openAgentPinModal(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) return;
  openAppModal(`
    <div>
      <p class="section-label">Agent Security</p>
      <h2>Change PIN</h2>
      <form id="agent-pin-form" class="stacked-form">
        <label>Agent<input type="text" value="${escapeHtml(employee.name)}" disabled></label>
        <label>New 4-Digit PIN<input type="password" id="edit-agent-pin" inputmode="numeric" maxlength="4" pattern="\\d{4}" required></label>
        <p id="agent-pin-feedback" class="feedback"></p>
        <div class="action-row">
          <button type="submit" class="primary-button">Update PIN</button>
          <button type="button" id="cancel-agent-pin" class="ghost-button">Cancel</button>
        </div>
      </form>
    </div>
  `, () => {
    document.getElementById("agent-pin-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const newPin = document.getElementById("edit-agent-pin").value.trim();
      const feedback = document.getElementById("agent-pin-feedback");
      if (!/^\d{4}$/.test(newPin)) {
        feedback.textContent = "PIN must be exactly 4 digits.";
        feedback.className = "feedback error";
        return;
      }
      employee.pin = newPin;
      persistState();
      closeLeaveModal();
      renderAdminPage();
    });
    document.getElementById("cancel-agent-pin").addEventListener("click", closeLeaveModal);
  });
}

function openAttendanceCorrectionModal(employeeId) {
  const employee = getEmployee(employeeId);
  const record = ensureDailyRecord(employeeId, getTodayKey());
  const baseTotalPlayers = getBaseTotalPlayers(employeeId, getTodayKey());
  if (!employee) return;
  openAppModal(`
    <div>
      <p class="section-label">Attendance Correction</p>
      <h2>Correct Today's Record</h2>
      <p class="muted-copy">Update ${escapeHtml(employee.name)}'s attendance and submitted progress for today without deleting the record.</p>
      <form id="attendance-correction-form" class="stacked-form">
        <label>Status
          <select id="correct-status">
            <option value="present" ${record.status === "present" ? "selected" : ""}>Checked In</option>
            <option value="completed" ${record.status === "completed" ? "selected" : ""}>Completed</option>
            <option value="absent" ${record.status === "absent" ? "selected" : ""}>Absent</option>
          </select>
        </label>
        <div class="time-grid">
          <label>Check-In Time<input type="time" id="correct-checkin" value="${toTimeInputValue(record.checkInAt)}"></label>
          <label>Check-Out Time<input type="time" id="correct-checkout" value="${toTimeInputValue(record.checkOutAt)}"></label>
        </div>
        <div class="report-grid">
          ${REPORT_FIELDS.map((field) => `<label>${field.label}<input type="number" min="0" id="correct-${field.key}" value="${record.report?.[field.key] ?? ""}"></label>`).join("")}
          <label class="full">Total Players (Auto Calculated)<input type="number" id="correct-total-players" value="${baseTotalPlayers + Number(record.report?.newPlayers || 0)}" disabled></label>
        </div>
        <p id="attendance-correction-feedback" class="feedback"></p>
        <div class="action-row">
          <button type="submit" class="primary-button">Save Correction</button>
          <button type="button" id="cancel-attendance-correction" class="ghost-button">Cancel</button>
        </div>
      </form>
    </div>
  `, () => {
    const updateTotalPlayers = () => {
      const newPlayers = Number(document.getElementById("correct-newPlayers").value || 0);
      document.getElementById("correct-total-players").value = baseTotalPlayers + newPlayers;
    };

    REPORT_FIELDS.forEach((field) => {
      document.getElementById(`correct-${field.key}`)?.addEventListener("input", updateTotalPlayers);
    });

    document.getElementById("attendance-correction-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const feedback = document.getElementById("attendance-correction-feedback");
      const status = document.getElementById("correct-status").value;
      const checkInValue = document.getElementById("correct-checkin").value;
      const checkOutValue = document.getElementById("correct-checkout").value;
      const report = {};
      REPORT_FIELDS.forEach((field) => {
        report[field.key] = Number(document.getElementById(`correct-${field.key}`).value || 0);
      });
      report.totalPlayers = baseTotalPlayers + report.newPlayers;
      const hasProgress = REPORT_FIELDS.some((field) => Number(report[field.key] || 0) > 0);
      if (checkInValue && checkOutValue && checkOutValue < checkInValue) {
        feedback.textContent = "Check-out time cannot be earlier than check-in time.";
        feedback.className = "feedback error";
        return;
      }
      if (status === "present" && !checkInValue) {
        feedback.textContent = "Checked In status needs a check-in time.";
        feedback.className = "feedback error";
        return;
      }
      if (status === "completed" && (!checkInValue || !checkOutValue)) {
        feedback.textContent = "Completed status needs both check-in and check-out times.";
        feedback.className = "feedback error";
        return;
      }
      record.status = status;
      record.checkInAt = status === "absent" || !checkInValue ? null : buildDateTimeForToday(checkInValue);
      record.checkOutAt = status === "absent" || !checkOutValue ? null : buildDateTimeForToday(checkOutValue);
      record.report = status === "absent" || !hasProgress ? null : report;
      persistState();
      closeLeaveModal();
      renderAdminPage();
      renderHome();
    });
    document.getElementById("cancel-attendance-correction").addEventListener("click", closeLeaveModal);
  });
}

function buildCheckoutSection(record, activeRecordDateKey) {
  const employee = getEmployee(activeEmployeeId);
  const previewReport = {
    huntingMessagesSent: Number(record.report?.huntingMessagesSent || 0),
    huntingRequestsSent: Number(record.report?.huntingRequestsSent || 0),
    postingOnIds: Number(record.report?.postingOnIds || 0),
    totalIds: Number(record.report?.totalIds || 0),
    deposit: Number(record.report?.deposit || 0),
    newPlayers: Number(record.report?.newPlayers || 0)
  };
  const totalPlayers = getBaseTotalPlayers(activeEmployeeId, activeRecordDateKey) + previewReport.newPlayers;
  return `
    <div class="dashboard-card">
      <h4>Check-Out Progress</h4>
      <p class="calendar-note">This check-out will be saved for ${formatDateLabel(activeRecordDateKey)}.</p>
      <form id="checkout-report-form" class="stacked-form">
        <div class="report-grid">
          ${REPORT_FIELDS.map((field) => `<label>${field.label}<input type="number" min="0" id="report-${field.key}" value="${record.report?.[field.key] ?? ""}"></label>`).join("")}
          <label class="full">Total Players (Auto Calculated)<input type="number" value="${totalPlayers}" disabled></label>
        </div>
        <div class="dashboard-card">
          <h4>WhatsApp Message Preview</h4>
          <pre id="report-preview-text" class="report-preview">${escapeHtml(buildWhatsAppReport(employee, previewReport, totalPlayers, activeRecordDateKey))}</pre>
          <button type="button" id="copy-report-message" class="ghost-button">Copy Message</button>
        </div>
        <div class="action-row">
          <button type="submit" class="primary-button">Confirm Check-Out</button>
          <button type="button" id="cancel-checkout" class="ghost-button">Cancel</button>
        </div>
      </form>
    </div>
  `;
}

function renderAdminPage() {
  if (!adminAuthorized) {
    renderAdminLoginPage();
    return;
  }

  adminPage.innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div><p class="section-label">Admin Panel</p><h2>Attendance Control Center</h2></div>
        <button id="admin-back" class="ghost-button">Back</button>
      </div>
      <div class="admin-switcher">
        <button class="${activeAdminSection === "monthly-attendance" ? "primary-button" : "ghost-button"}" id="admin-monthly-attendance-tab">Monthly Attendance</button>
        <button class="${activeAdminSection === "monthly-progress" ? "primary-button" : "ghost-button"}" id="admin-monthly-progress-tab">Monthly Progress</button>
        <button class="${activeAdminSection === "operations" ? "primary-button" : "ghost-button"}" id="admin-operations-tab">Operations</button>
      </div>
      <div class="admin-layout">
        <section class="admin-section ${activeAdminSection === "operations" ? "" : "hidden"}">
          <h3>Add Agent</h3>
          <form id="employee-form" class="stacked-form">
            <label>Name<input type="text" id="employee-name" required></label>
            <label>PIN<input type="password" id="employee-pin" required maxlength="4"></label>
            <label>Shift<select id="employee-shift"></select></label>
            <label>Agent Color<input type="color" id="employee-color" value="#2f6feb"></label>
            <div class="time-grid">
              <label>Monthly Players Target<input type="number" id="employee-target-players" min="0" value="0"></label>
              <label>Monthly Deposit Target<input type="number" id="employee-target-deposit" min="0" value="0"></label>
            </div>
            <button type="submit" class="primary-button">Add Agent</button>
          </form>
        </section>
        <section class="admin-section ${activeAdminSection === "operations" ? "" : "hidden"}">
          <h3>Admin Security</h3>
          <form id="admin-password-form" class="stacked-form">
            <label>Current Password<input type="password" id="admin-current-password" required></label>
            <label>New Password<input type="password" id="admin-new-password" required></label>
            <button type="submit" class="secondary-button">Change Admin Password</button>
          </form>
          <p id="admin-password-feedback" class="feedback"></p>
        </section>
        <section class="admin-section full-span ${activeAdminSection === "operations" ? "" : "hidden"}">
          <h3>Leave Requests</h3>
          <div id="leave-requests-list" class="admin-employee-list"></div>
        </section>
        <section class="admin-section full-span ${activeAdminSection === "operations" ? "" : "hidden"}">
          <h3>Schedule Off</h3>
          <form id="off-form" class="stacked-form">
            <div class="time-grid">
              <label>Agent<select id="off-employee-select"></select></label>
              <label>Date<input type="date" id="off-date" value="${getTodayKey()}"></label>
            </div>
            <div class="time-grid">
              <label>Reason<select id="off-reason-select">${state.offReasons.map((reason) => `<option value="${reason}">${escapeHtml(reason)}</option>`).join("")}</select></label>
              <label>Custom Reason<input type="text" id="off-custom-reason" placeholder="Only if Custom"></label>
            </div>
            <button type="submit" class="secondary-button">Save Schedule Off</button>
          </form>
          <div id="scheduled-off-list" class="admin-employee-list"></div>
        </section>
        <section class="admin-section full-span ${activeAdminSection === "operations" ? "" : "hidden"}">
          <h3>Agents</h3>
          <div id="admin-employee-list" class="admin-employee-list"></div>
        </section>
        <section class="admin-section full-span ${activeAdminSection === "operations" ? "" : "hidden"}">
          <h3>Reports & Backups</h3>
          <div class="admin-ops-grid">
            <div class="dashboard-card">
              <h4>Export Reports</h4>
              <p class="muted-copy">Download monthly reports for one agent or the full team.</p>
              <form id="report-export-form" class="stacked-form">
                <div class="time-grid">
                  <label>Month<select id="report-month-select"></select></label>
                  <label>Scope<select id="report-scope-select"></select></label>
                </div>
                <div class="action-row">
                  <button type="submit" class="primary-button">Download CSV</button>
                  <button type="button" id="download-report-json" class="ghost-button">Download JSON</button>
                </div>
              </form>
            </div>
            <div class="dashboard-card">
              <h4>Backups</h4>
              <p class="muted-copy">Create cloud snapshots and download full backups for safety.</p>
              <div class="action-row">
                <button type="button" id="create-cloud-backup" class="primary-button">Create Cloud Backup</button>
                <button type="button" id="download-full-backup" class="ghost-button">Download Full Backup</button>
              </div>
              <p id="backup-feedback" class="feedback"></p>
              <div id="backup-list" class="admin-employee-list"></div>
            </div>
          </div>
        </section>
        <section class="admin-section full-span ${activeAdminSection === "monthly-attendance" ? "" : "hidden"}">
          <h3>Monthly Attendance</h3>
          <p class="muted-copy">Date-wise attendance of the full team for the current month.</p>
          <div id="admin-monthly-attendance-list" class="admin-employee-list"></div>
        </section>
        <section class="admin-section full-span ${activeAdminSection === "monthly-progress" ? "" : "hidden"}">
          <h3>Monthly Progress</h3>
          <p class="muted-copy">Open any agent to review averages and the full monthly progress report.</p>
          <div id="admin-monthly-progress-list" class="admin-employee-list"></div>
        </section>
      </div>
    </section>
  `;

  document.getElementById("admin-back").addEventListener("click", () => {
    currentView = "home";
    adminAuthorized = false;
    renderAll();
  });
  document.getElementById("admin-monthly-attendance-tab").addEventListener("click", () => {
    activeAdminSection = "monthly-attendance";
    renderAdminPage();
  });
  document.getElementById("admin-monthly-progress-tab").addEventListener("click", () => {
    activeAdminSection = "monthly-progress";
    renderAdminPage();
  });
  document.getElementById("admin-operations-tab").addEventListener("click", () => {
    activeAdminSection = "operations";
    renderAdminPage();
  });

  bindAdmin();
  fillAdmin();
}

function renderAdminLoginPage() {
  adminPage.innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div><p class="section-label">Admin Panel</p><h2>Admin Login</h2></div>
        <button id="admin-back" class="ghost-button">Back</button>
      </div>
      <div class="pin-shell">
        <div class="pin-box">
          <p class="section-label">Secure Access</p>
          <h3>Enter admin password</h3>
          <form id="admin-login-form" class="stacked-form">
            <label>Password<input type="password" id="admin-login-password" autocomplete="off" required></label>
            <button type="submit" class="primary-button">Login</button>
          </form>
          <p id="admin-login-feedback" class="feedback"></p>
        </div>
      </div>
    </section>
  `;

  document.getElementById("admin-back").addEventListener("click", () => {
    currentView = "home";
    adminAuthorized = false;
    renderAll();
  });

  document.getElementById("admin-login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = document.getElementById("admin-login-password").value;
    const feedback = document.getElementById("admin-login-feedback");
    if (value !== state.adminPassword) {
      feedback.textContent = "Incorrect admin password.";
      feedback.className = "feedback error";
      return;
    }
    adminAuthorized = true;
    renderAdminPage();
  });
}

function bindAdmin() {
  if (document.getElementById("employee-shift")) {
    document.getElementById("employee-shift").innerHTML = state.shifts.map((shift) => `<option value="${shift.id}">${escapeHtml(shift.name)} (${formatShiftWindow(shift)})</option>`).join("");
  }
  if (document.getElementById("off-employee-select")) {
    document.getElementById("off-employee-select").innerHTML = state.employees.map((employee) => `<option value="${employee.id}">${escapeHtml(employee.name)}</option>`).join("");
  }

  document.getElementById("employee-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.getElementById("employee-name").value.trim();
    const pin = document.getElementById("employee-pin").value.trim();
    if (!name || !/^\d{4}$/.test(pin)) return;
    state.employees.unshift({
      id: createId("emp"),
      name,
      pin,
      shiftId: document.getElementById("employee-shift").value,
      color: document.getElementById("employee-color").value,
      targets: { newPlayers: Number(document.getElementById("employee-target-players").value || 0), deposit: Number(document.getElementById("employee-target-deposit").value || 0) }
    });
    persistState();
    renderAdminPage();
  });

  document.getElementById("off-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const employeeId = document.getElementById("off-employee-select").value;
    const date = document.getElementById("off-date").value;
    const reason = document.getElementById("off-reason-select").value;
    const customReason = document.getElementById("off-custom-reason").value.trim();
    const record = ensureDailyRecord(employeeId, date);
    record.status = "off";
    record.offReason = reason === "Custom" ? customReason || "Custom" : reason;
    record.checkInAt = null;
    record.checkOutAt = null;
    persistState();
    renderAdminPage();
  });

  document.getElementById("admin-password-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const currentPassword = document.getElementById("admin-current-password").value;
    const newPassword = document.getElementById("admin-new-password").value.trim();
    const feedback = document.getElementById("admin-password-feedback");
    if (currentPassword !== state.adminPassword) {
      feedback.textContent = "Current password is incorrect.";
      feedback.className = "feedback error";
      return;
    }
    if (!newPassword) {
      feedback.textContent = "New password cannot be empty.";
      feedback.className = "feedback error";
      return;
    }
    state.adminPassword = newPassword;
    persistState();
    feedback.textContent = "Admin password updated.";
    feedback.className = "feedback success";
    document.getElementById("admin-password-form").reset();
  });

  if (document.getElementById("report-month-select")) {
    document.getElementById("report-month-select").innerHTML = getAvailableReportMonths()
      .map((month) => `<option value="${month}">${formatMonthLabel(month)}</option>`)
      .join("");
  }

  if (document.getElementById("report-scope-select")) {
    document.getElementById("report-scope-select").innerHTML = [
      `<option value="team">Whole Team</option>`,
      ...state.employees.map((employee) => `<option value="${employee.id}">${escapeHtml(employee.name)}</option>`)
    ].join("");
  }

  document.getElementById("report-export-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const monthKey = document.getElementById("report-month-select").value;
    const scope = document.getElementById("report-scope-select").value;
    downloadTextFile(buildReportFileName(monthKey, scope, "csv"), buildMonthlyReportCsv(monthKey, scope), "text/csv;charset=utf-8;");
  });

  document.getElementById("download-report-json")?.addEventListener("click", () => {
    const monthKey = document.getElementById("report-month-select").value;
    const scope = document.getElementById("report-scope-select").value;
    downloadTextFile(buildReportFileName(monthKey, scope, "json"), JSON.stringify(buildMonthlyReportRows(monthKey, scope), null, 2), "application/json");
  });

  document.getElementById("download-full-backup")?.addEventListener("click", () => {
    downloadTextFile(`team-alpha-backup-${getTodayKey()}.json`, JSON.stringify(state, null, 2), "application/json");
  });

  document.getElementById("create-cloud-backup")?.addEventListener("click", async () => {
    const feedback = document.getElementById("backup-feedback");
    feedback.textContent = "Creating cloud backup...";
    feedback.className = "feedback";
    const result = await createCloudBackup();
    if (result.ok) {
      feedback.textContent = "Cloud backup created successfully.";
      feedback.className = "feedback success";
      renderAdminPage();
    } else {
      feedback.textContent = result.message;
      feedback.className = "feedback error";
    }
  });
}

function fillAdmin() {
  const leaveRequestsList = document.getElementById("leave-requests-list");
  const scheduledOffList = document.getElementById("scheduled-off-list");
  const adminEmployeeList = document.getElementById("admin-employee-list");
  const adminMonthlyAttendanceList = document.getElementById("admin-monthly-attendance-list");
  const adminMonthlyProgressList = document.getElementById("admin-monthly-progress-list");
  const backupList = document.getElementById("backup-list");

  if (leaveRequestsList) {
    leaveRequestsList.innerHTML = state.leaveRequests.length ? `
    <div class="report-table-wrap">
      <table class="report-table admin-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Date</th>
            <th>Reason</th>
            <th>Description</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${state.leaveRequests.map((request) => {
            const employee = getEmployee(request.employeeId);
            return `
              <tr>
                <td>${escapeHtml(employee?.name || "Unknown")}</td>
                <td>${request.date}</td>
                <td>${escapeHtml(request.reason)}</td>
                <td>${escapeHtml(request.description)}</td>
                <td>${renderAdminStatusChip(request.status)}</td>
                <td>
                  <div class="inline-actions">
                    ${request.status === "pending" || request.status === "cancel-requested"
                      ? `<button class="primary-button admin-table-btn" data-approve="${request.id}">${request.status === "cancel-requested" ? "Approve Cancel" : "Approve"}</button><button class="danger-button admin-table-btn" data-reject="${request.id}">${request.status === "cancel-requested" ? "Reject Cancel" : "Reject"}</button>`
                      : ``}
                    <button class="ghost-button admin-table-btn" data-edit-admin-leave="${request.id}">Edit</button>
                    <button class="danger-button admin-table-btn" data-delete-admin-leave="${request.id}">Delete</button>
                  </div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  ` : `<div class="empty-state">No leave requests yet.</div>`;
    leaveRequestsList.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => reviewLeave(button.dataset.approve, true)));
    leaveRequestsList.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => reviewLeave(button.dataset.reject, false)));
    leaveRequestsList.querySelectorAll("[data-edit-admin-leave]").forEach((button) => button.addEventListener("click", () => openAdminLeaveEditModal(button.dataset.editAdminLeave)));
    leaveRequestsList.querySelectorAll("[data-delete-admin-leave]").forEach((button) => button.addEventListener("click", () => {
      const requestId = button.dataset.deleteAdminLeave;
      openConfirmModal({
        title: "Delete Leave Request",
        message: "Delete this leave request permanently?",
        confirmLabel: "Delete Request",
        onConfirm: () => {
          removeLeaveRequest(requestId);
          renderAdminPage();
        }
      });
    }));
  }

  const offEntries = collectOffEntries();
  if (scheduledOffList) {
    scheduledOffList.innerHTML = offEntries.length ? `
    <div class="report-table-wrap">
      <table class="report-table admin-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Date</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${offEntries.map((entry) => `
            <tr>
              <td>${escapeHtml(entry.employee.name)}</td>
              <td>${entry.date}</td>
              <td>${escapeHtml(entry.reason)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  ` : `<div class="empty-state">No scheduled off entries.</div>`;
  }

  if (adminEmployeeList) {
    adminEmployeeList.innerHTML = `
    <div class="report-table-wrap">
      <table class="report-table admin-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Shift</th>
            <th>Targets</th>
            <th>Today</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${state.employees.map((employee) => {
    const todayRecord = getDailyRecord(employee.id, getTodayKey());
    const shift = getShift(employee.shiftId);
    return `
      <tr>
        <td>
          <div class="admin-agent-cell">
            <span class="admin-agent-dot" style="background:${employee.color};"></span>
            <span>${escapeHtml(employee.name)}</span>
          </div>
        </td>
        <td>${shift ? `${escapeHtml(shift.name)} - ${formatShiftWindow(shift)}` : "Unassigned"}</td>
        <td>${employee.targets.newPlayers} players, ${formatCurrency(employee.targets.deposit)} deposit</td>
        <td>${todayRecord.checkInAt || todayRecord.checkOutAt ? `${todayRecord.checkInAt ? formatShortTime(todayRecord.checkInAt) : "--"} / ${todayRecord.checkOutAt ? formatShortTime(todayRecord.checkOutAt) : "--"}` : "-- / --"}</td>
        <td>
          <div class="inline-actions">
            <button class="ghost-button admin-table-btn" data-edit-agent="${employee.id}">Edit</button>
            <button class="ghost-button admin-table-btn" data-change-agent-pin="${employee.id}">Change PIN</button>
            <button class="ghost-button admin-table-btn" data-reset-attendance="${employee.id}">Correct</button>
            <button class="danger-button admin-table-btn" data-delete-agent="${employee.id}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("")}
        </tbody>
      </table>
    </div>
  `;

    adminEmployeeList.querySelectorAll("[data-edit-agent]").forEach((button) => button.addEventListener("click", () => {
      openAgentEditModal(button.dataset.editAgent);
    }));
    adminEmployeeList.querySelectorAll("[data-change-agent-pin]").forEach((button) => button.addEventListener("click", () => {
      openAgentPinModal(button.dataset.changeAgentPin);
    }));
    adminEmployeeList.querySelectorAll("[data-reset-attendance]").forEach((button) => button.addEventListener("click", () => {
      openAttendanceCorrectionModal(button.dataset.resetAttendance);
    }));
    adminEmployeeList.querySelectorAll("[data-delete-agent]").forEach((button) => button.addEventListener("click", () => {
      const employeeId = button.dataset.deleteAgent;
      const employee = getEmployee(employeeId);
      openConfirmModal({
        title: "Delete Agent",
        message: `Delete ${employee?.name || "this agent"} and all related attendance, progress, and leave records? This cannot be undone.`,
        confirmLabel: "Delete Agent",
        onConfirm: () => {
          state.employees = state.employees.filter((entry) => entry.id !== employeeId);
          state.leaveRequests = state.leaveRequests.filter((request) => request.employeeId !== employeeId);
          Object.keys(state.records).forEach((dateKey) => delete state.records[dateKey][employeeId]);
          persistState();
          renderAdminPage();
          renderHome();
        }
      });
    }));
  }

  if (adminMonthlyAttendanceList) {
    adminMonthlyAttendanceList.innerHTML = renderAdminMonthlyAttendanceDashboard();
  }

  if (adminMonthlyProgressList) {
    if (!activeAdminProgressEmployeeId || !getEmployee(activeAdminProgressEmployeeId)) {
      activeAdminProgressEmployeeId = state.employees[0]?.id || null;
    }
    adminMonthlyProgressList.innerHTML = renderAdminMonthlyProgressDashboard();
    adminMonthlyProgressList.querySelectorAll("[data-progress-agent]").forEach((button) => {
      button.addEventListener("click", () => {
        activeAdminProgressEmployeeId = button.dataset.progressAgent;
        renderAdminPage();
      });
    });
  }

  if (backupList) {
    backupList.innerHTML = cloudBackups.length ? `
      <div class="report-table-wrap">
        <table class="report-table report-table-compact admin-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Label</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${cloudBackups.map((backup) => `
              <tr>
                <td>${formatDateTime(backup.created_at)}</td>
                <td>${escapeHtml(backup.label || "Manual Backup")}</td>
                <td>
                  <div class="inline-actions">
                    <button type="button" class="ghost-button admin-table-btn" data-download-backup="${backup.id}">Download</button>
                    <button type="button" class="secondary-button admin-table-btn" data-restore-backup="${backup.id}">Restore</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : `<div class="empty-state">No cloud backups yet.</div>`;

    backupList.querySelectorAll("[data-download-backup]").forEach((button) => {
      button.addEventListener("click", () => {
        const backup = cloudBackups.find((entry) => entry.id === button.dataset.downloadBackup);
        if (!backup) return;
        downloadTextFile(`team-alpha-backup-${backup.id}.json`, JSON.stringify(normalizeState(backup.data || {}), null, 2), "application/json");
      });
    });

    backupList.querySelectorAll("[data-restore-backup]").forEach((button) => {
      button.addEventListener("click", () => {
        const backup = cloudBackups.find((entry) => entry.id === button.dataset.restoreBackup);
        if (!backup) return;
        openConfirmModal({
          title: "Restore Backup",
          message: "Restore this backup and replace the current live data for the whole team?",
          confirmLabel: "Restore Backup",
          confirmClass: "secondary-button",
          onConfirm: async () => {
            state = normalizeState(backup.data || {});
            persistState();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            renderAll();
          }
        });
      });
    });
  }
}

function collectAdminProgressRows() {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return Object.entries(state.records)
    .filter(([date]) => date.startsWith(monthPrefix))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([date, records]) => Object.entries(records)
      .map(([employeeId, record]) => {
        const employee = getEmployee(employeeId);
        return employee ? { date, employee, record } : null;
      })
      .filter(Boolean));
}

function renderAdminMonthlyAttendanceDashboard() {
  return `
    <section class="dashboard-card">
      <h4>Monthly Attendance Overview</h4>
      <p class="muted-copy">Current month attendance with each date in rows and all agents in columns.</p>
      <div class="metric-grid admin-summary-grid">
        ${state.employees.map((employee) => {
          const stats = getAttendanceStats(employee.id);
          return `
            <article class="metric-card">
              <div class="metric-copy">
                <span class="section-label">${escapeHtml(employee.name)}</span>
                <strong>Late ${stats.late}</strong>
                <p>Absents ${stats.absent}</p>
              </div>
            </article>
          `;
        }).join("")}
      </div>
      ${renderAdminAttendanceMatrix()}
    </section>
  `;
}

function renderAdminMonthlyProgressDashboard() {
  return `
    <section class="dashboard-card">
      <h4>Monthly Progress</h4>
      <p class="muted-copy">Click an agent to view complete monthly performance and daily averages.</p>
      <div class="admin-agent-switcher">
        ${state.employees.map((employee) => `
          <button class="${activeAdminProgressEmployeeId === employee.id ? "primary-button" : "ghost-button"}" data-progress-agent="${employee.id}">${escapeHtml(employee.name)}</button>
        `).join("")}
      </div>
      ${activeAdminProgressEmployeeId ? renderAdminAgentProgressDetail(activeAdminProgressEmployeeId) : `<div class="empty-state">No agents available.</div>`}
    </section>
  `;
}

function getAvailableReportMonths() {
  const months = new Set([getTodayKey().slice(0, 7)]);
  Object.keys(state.records).forEach((dateKey) => months.add(dateKey.slice(0, 7)));
  return Array.from(months).sort((a, b) => b.localeCompare(a));
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
}

function buildMonthlyReportRows(monthKey, scope) {
  const employeeIds = scope === "team" ? state.employees.map((employee) => employee.id) : [scope];
  const rows = [];
  Object.entries(state.records)
    .filter(([dateKey]) => dateKey.startsWith(monthKey))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([dateKey, records]) => {
      employeeIds.forEach((employeeId) => {
        const employee = getEmployee(employeeId);
        const record = records[employeeId];
        if (!employee || !record) return;
        rows.push({
          date: dateKey,
          agent: employee.name,
          checkIn: record.checkInAt ? formatShortTime(record.checkInAt) : "",
          checkOut: record.checkOutAt ? formatShortTime(record.checkOutAt) : "",
          messages: record.report?.huntingMessagesSent ?? 0,
          requests: record.report?.huntingRequestsSent ?? 0,
          posting: record.report?.postingOnIds ?? 0,
          ids: record.report?.totalIds ?? 0,
          deposit: record.report?.deposit ?? 0,
          newPlayers: record.report?.newPlayers ?? 0,
          totalPlayers: record.report?.totalPlayers ?? 0,
          status: getExportStatus(record)
        });
      });
    });
  return rows;
}

function buildMonthlyReportCsv(monthKey, scope) {
  const rows = buildMonthlyReportRows(monthKey, scope);
  const headers = ["Date", "Agent", "Check-In", "Check-Out", "Messages", "Requests", "Posting", "IDs", "Deposit", "New Players", "Total Players", "Status"];
  const csvRows = [headers.join(",")];
  rows.forEach((row) => {
    csvRows.push([
      row.date,
      row.agent,
      row.checkIn,
      row.checkOut,
      row.messages,
      row.requests,
      row.posting,
      row.ids,
      row.deposit,
      row.newPlayers,
      row.totalPlayers,
      row.status
    ].map(escapeCsvValue).join(","));
  });
  return csvRows.join("\n");
}

function buildReportFileName(monthKey, scope, extension) {
  const scopeLabel = scope === "team" ? "whole-team" : slugify(getEmployee(scope)?.name || "agent");
  return `team-alpha-${monthKey}-${scopeLabel}-report.${extension}`;
}

function getExportStatus(record) {
  if (record.status === "leave-approved") return "Leave Approved";
  if (record.status === "off") return "Scheduled Off";
  if (record.report) return "Submitted";
  if (record.checkInAt || record.checkOutAt) return "Attendance Only";
  return "Pending";
}

function downloadTextFile(fileName, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderAdminAttendanceMatrix() {
  const dates = getCurrentMonthDateKeys();
  return `
    <div class="report-table-wrap">
      <table class="report-table report-table-compact admin-table attendance-matrix">
        <thead>
          <tr>
            <th>Date</th>
            ${state.employees.map((employee) => `<th>${escapeHtml(employee.name)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${dates.map((dateKey) => `
            <tr>
              <td>${formatDateLabel(dateKey)}</td>
              ${state.employees.map((employee) => {
                const record = getDailyRecord(employee.id, dateKey);
                return `<td>${renderAttendanceMatrixCell(record)}</td>`;
              }).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAttendanceMatrixCell(record) {
  if (record.status === "leave-approved") return `<div class="matrix-cell"><strong>Leave</strong></div>`;
  if (record.status === "off") return `<div class="matrix-cell"><strong>Off</strong></div>`;
  if (record.checkInAt || record.checkOutAt) {
    return `<div class="matrix-cell"><strong>${record.checkInAt ? formatShortTime(record.checkInAt) : "--"}</strong><span>${record.checkOutAt ? formatShortTime(record.checkOutAt) : "--"}</span></div>`;
  }
  return `<div class="matrix-cell"><strong>--</strong><span>--</span></div>`;
}

function renderAdminAgentProgressDetail(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) return `<div class="empty-state">Agent not found.</div>`;
  const averages = getAverageProgressStats(employeeId);
  const totals = getAgentMonthlyTotals(employeeId);
  return `
    <div class="metric-grid admin-average-grid">
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Avg Messages</span><strong>${averages.huntingMessagesSent}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Avg Requests</span><strong>${averages.huntingRequestsSent}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Avg Posting</span><strong>${averages.postingOnIds}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Avg IDs</span><strong>${averages.totalIds}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Avg Deposit</span><strong>${formatPlainNumber(averages.deposit)}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Avg New Players</span><strong>${averages.newPlayers}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Total Deposit</span><strong>${formatPlainNumber(totals.totalDeposit)}</strong></div></article>
      <article class="metric-card"><div class="metric-copy"><span class="section-label">Total Players</span><strong>${totals.totalPlayers}</strong></div></article>
    </div>
    <section style="margin-top:18px;">
      <h4>${escapeHtml(employee.name)} Monthly Report</h4>
      <p class="muted-copy">Complete month-wise attendance and submitted progress for this agent.</p>
      ${renderMonthlyReport(employeeId)}
    </section>
  `;
}

function getAverageProgressStats(employeeId) {
  const monthRecords = getMonthRecords(employeeId).filter(({ record }) => record.report);
  if (!monthRecords.length) {
    return { huntingMessagesSent: 0, huntingRequestsSent: 0, postingOnIds: 0, totalIds: 0, deposit: 0, newPlayers: 0 };
  }
  const totals = monthRecords.reduce((summary, { record }) => {
    summary.huntingMessagesSent += Number(record.report.huntingMessagesSent || 0);
    summary.huntingRequestsSent += Number(record.report.huntingRequestsSent || 0);
    summary.postingOnIds += Number(record.report.postingOnIds || 0);
    summary.totalIds += Number(record.report.totalIds || 0);
    summary.deposit += Number(record.report.deposit || 0);
    summary.newPlayers += Number(record.report.newPlayers || 0);
    return summary;
  }, { huntingMessagesSent: 0, huntingRequestsSent: 0, postingOnIds: 0, totalIds: 0, deposit: 0, newPlayers: 0 });
  const divisor = monthRecords.length;
  return {
    huntingMessagesSent: Math.round(totals.huntingMessagesSent / divisor),
    huntingRequestsSent: Math.round(totals.huntingRequestsSent / divisor),
    postingOnIds: Math.round(totals.postingOnIds / divisor),
    totalIds: Math.round(totals.totalIds / divisor),
    deposit: Math.round(totals.deposit / divisor),
    newPlayers: Math.round(totals.newPlayers / divisor)
  };
}

function getAgentMonthlyTotals(employeeId) {
  const monthRecords = getMonthRecords(employeeId).filter(({ record }) => record.report);
  const totalDeposit = monthRecords.reduce((sum, { record }) => sum + Number(record.report.deposit || 0), 0);
  const latestTotalPlayers = monthRecords.length ? Number(monthRecords[monthRecords.length - 1].record.report.totalPlayers || 0) : 0;
  return {
    totalDeposit,
    totalPlayers: latestTotalPlayers
  };
}

function getCurrentMonthDateKeys() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: totalDays }, (_, index) => toDateKey(new Date(year, month, index + 1)));
}

function renderAdminStatusChip(status) {
  if (status === "approved") {
    return `<span class="table-chip chip-done">Approved</span>`;
  }
  if (status === "cancel-requested") {
    return `<span class="table-chip chip-pending">Cancel Requested</span>`;
  }
  if (status === "cancelled") {
    return `<span class="table-chip chip-off">Cancelled</span>`;
  }
  if (status === "rejected") {
    return `<span class="table-chip chip-off">Rejected</span>`;
  }
  return `<span class="table-chip chip-pending">Pending</span>`;
}
function reviewLeave(requestId, approved) {
  const request = state.leaveRequests.find((item) => item.id === requestId);
  if (!request) return;
  if (request.status === "cancel-requested") {
    request.status = approved ? "cancelled" : "approved";
  } else {
    request.status = approved ? "approved" : "rejected";
  }
  syncLeaveRequestToRecord(request);
  persistState();
  renderAdminPage();
  renderHome();
}

function collectOffEntries() {
  const entries = [];
  Object.entries(state.records).forEach(([date, records]) => {
    Object.entries(records).forEach(([employeeId, record]) => {
      if (record.status === "off") {
        const employee = getEmployee(employeeId);
        if (employee) entries.push({ date, employee, reason: record.offReason || "Off" });
      }
    });
  });
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

function renderCalendar(employeeId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cells = [];
  for (let i = 0; i < 7; i += 1) cells.push(`<div class="calendar-head">${WEEKDAYS[i]}</div>`);
  for (let i = 0; i < first.getDay(); i += 1) cells.push(`<div class="calendar-day empty"></div>`);

  for (let day = 1; day <= last.getDate(); day += 1) {
    const date = new Date(year, month, day);
    const key = toDateKey(date);
    const record = getDailyRecord(employeeId, key);
    const today = key === getTodayKey();
    let badge = `<span class="tiny-badge tiny-absent">Absent</span>`;
    const lines = [];
    if (record.status === "off") {
      badge = `<span class="tiny-badge tiny-leave">Off</span>`;
      lines.push(`<small>${escapeHtml(record.offReason || "Off")}</small>`);
    } else if (record.status === "leave-approved") {
      badge = `<span class="tiny-badge tiny-leave">Leave</span>`;
      lines.push(`<small>${escapeHtml(record.leaveRequest?.reason || "Leave")}</small>`);
    } else if (record.checkOutAt) {
      badge = `<span class="tiny-badge tiny-present">Done</span>`;
      lines.push(`<small>In ${formatShortTime(record.checkInAt)}</small>`);
      lines.push(`<small>Out ${formatShortTime(record.checkOutAt)}</small>`);
      if (record.report) lines.push(`<small>New ${record.report.newPlayers || 0} | Dep ${record.report.deposit || 0}</small>`);
    } else if (record.checkInAt) {
      badge = `<span class="tiny-badge tiny-pending">Checked In</span>`;
      lines.push(`<small>In ${formatShortTime(record.checkInAt)}</small>`);
    }
    cells.push(`<div class="calendar-day ${today ? "today" : ""}"><span class="day-number">${day}</span>${badge}${lines.join("")}</div>`);
  }

  return `<div class="calendar-grid">${cells.join("")}</div>`;
}

function renderMonthlyReport(employeeId) {
  const monthRecords = getMonthRecords(employeeId);
  if (!monthRecords.length) return `<div class="empty-state">No monthly report data yet.</div>`;
  return `
    <div class="report-table-wrap report-table-static">
      <table class="report-table report-table-compact">
        <thead>
          <tr>
            <th>Date</th>
            <th>Check-In</th>
            <th>Check-Out</th>
            <th>Messages</th>
            <th>Requests</th>
            <th>Posting</th>
            <th>IDs</th>
            <th>Deposit</th>
            <th>New Players</th>
            <th>Total Players</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${monthRecords.map(({ key, record }) => `
            <tr>
              <td class="report-date-cell">
                <div class="report-date-main">${formatDateLabel(key)}</div>
              </td>
              <td class="report-time-cell">${record.checkInAt ? formatShortTime(record.checkInAt) : "--"}</td>
              <td class="report-time-cell">${record.checkOutAt ? formatShortTime(record.checkOutAt) : "--"}</td>
              <td>${record.report?.huntingMessagesSent ?? 0}</td>
              <td>${record.report?.huntingRequestsSent ?? 0}</td>
              <td>${record.report?.postingOnIds ?? 0}</td>
              <td>${record.report?.totalIds ?? 0}</td>
              <td>${formatPlainNumber(record.report?.deposit ?? 0)}</td>
              <td>${record.report?.newPlayers ?? 0}</td>
              <td>${record.report?.totalPlayers ?? 0}</td>
              <td>${renderProgressCell(record)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderProgressCell(record) {
  if (record.status === "leave-approved") {
    return `
      <div class="progress-cell">
        <span class="table-chip chip-leave">Leave Approved</span>
      </div>
    `;
  }

  if (record.status === "off") {
    return `
      <div class="progress-cell">
        <span class="table-chip chip-off">Scheduled Off</span>
      </div>
    `;
  }

  if (!record.report) {
    return `
      <div class="progress-cell">
        <span class="table-chip chip-pending">Pending</span>
      </div>
    `;
  }

  return `
    <div class="progress-cell">
      <span class="table-chip chip-done">Submitted</span>
    </div>
  `;
}

function getMonthRecords(employeeId) {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return Object.entries(state.records).filter(([key, records]) => key.startsWith(monthPrefix) && records[employeeId]).sort((a, b) => a[0].localeCompare(b[0])).map(([key, records]) => ({ key, record: records[employeeId] }));
}

function getMonthlySummary(employeeId) {
  return getMonthRecords(employeeId).reduce((summary, { record }) => {
    if (record.report) {
      summary.newPlayers += Number(record.report.newPlayers || 0);
      summary.deposit += Number(record.report.deposit || 0);
    }
    return summary;
  }, { newPlayers: 0, deposit: 0 });
}

function getBaseTotalPlayers(employeeId, upToDate) {
  let total = 0;
  getMonthRecords(employeeId).forEach(({ key, record }) => {
    if (key < upToDate && record.report) {
      total += Number(record.report.newPlayers || 0);
    }
  });
  return total;
}

function getAttendanceStats(employeeId) {
  const monthRecords = getMonthRecords(employeeId);
  return monthRecords.reduce((stats, { record }) => {
    if (record.checkInAt) {
      const shift = getShift(getEmployee(employeeId)?.shiftId);
      if (shift && isLateCheckIn(record.checkInAt, shift.start)) {
        stats.late += 1;
      }
    } else if (record.status !== "off" && record.status !== "leave-approved") {
      stats.absent += 1;
    }
    return stats;
  }, { late: 0, absent: 0 });
}

function getTargetPace(employeeId) {
  const employee = getEmployee(employeeId);
  const monthlySummary = getMonthlySummary(employeeId);
  const now = new Date();
  const elapsed = Math.max(1, now.getDate());
  const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expectedPlayers = Math.round((employee.targets.newPlayers / totalDays) * elapsed);
  const expectedDeposit = Math.round((employee.targets.deposit / totalDays) * elapsed);
  return {
    expectedPlayers,
    expectedDeposit,
    playersBehind: Math.max(0, expectedPlayers - monthlySummary.newPlayers),
    depositBehind: Math.max(0, expectedDeposit - monthlySummary.deposit),
    projectedPlayers: Math.round((monthlySummary.newPlayers / elapsed) * totalDays),
    projectedDeposit: Math.round((monthlySummary.deposit / elapsed) * totalDays)
  };
}

function getTodayEmployeeStatus(employee) {
  const record = getStatusRecordForNow(employee, getTodayKey());
  if (record.checkInAt && !record.checkOutAt) return { label: "Checked In / Available", className: "checked-in" };
  if (record.checkOutAt) return { label: "Checked Out", className: "done" };
  if (record.status === "off") return { label: "Scheduled Off", className: "leave" };
  if (record.status === "leave-approved") return { label: "On Leave", className: "leave" };
  return { label: "Not Checked In", className: "idle" };
}

function getStatusRecordForNow(employee, todayKey) {
  const activeDateKey = getActivePortalRecordDateKey(employee);
  if (activeDateKey !== todayKey) {
    const activeRecord = getDailyRecord(employee.id, activeDateKey);
    if (activeRecord.checkInAt || activeRecord.checkOutAt) {
      return activeRecord;
    }
  }
  return getDailyRecord(employee.id, todayKey);
}

function getLatestMissedCheckoutRecord(employeeId, activeRecordDateKey) {
  const previousRecords = Object.entries(state.records)
    .filter(([dateKey]) => dateKey < activeRecordDateKey)
    .sort((a, b) => b[0].localeCompare(a[0]));

  for (const [dateKey, recordsByEmployee] of previousRecords) {
    const record = recordsByEmployee?.[employeeId];
    if (record?.checkInAt && !record?.checkOutAt && !record?.missedCheckoutAcknowledged) {
      return { id: `${employeeId}-${dateKey}`, date: dateKey, record };
    }
  }

  return null;
}

function getReasonLabel(record) {
  if (record.status === "off") return record.offReason || "Off";
  if (record.status === "leave-approved") return record.leaveRequest?.reason || "Leave";
  return "";
}

function formatLeaveRequestStatus(status) {
  if (status === "approved") return "Approved";
  if (status === "cancel-requested") return "Cancel Requested";
  if (status === "cancelled") return "Cancelled";
  if (status === "rejected") return "Rejected";
  return "Pending";
}

function getActivePortalRecordDateKey(employee) {
  const shift = getShift(employee.shiftId);
  const now = new Date();
  const todayKey = toDateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowKey = toDateKey(tomorrow);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  if (shift && isEveningShift(shift)) {
    const previousRecord = getDailyRecord(employee.id, yesterdayKey);
    if (previousRecord.checkInAt && !previousRecord.checkOutAt && currentMinutes < 3 * 60) {
      return yesterdayKey;
    }
  }

  if (shift && shift.start === "00:00" && currentMinutes >= 23 * 60 + 30) {
    return tomorrowKey;
  }

  return todayKey;
}

function doesShiftCrossMidnight(shift) {
  if (!shift) return false;
  return shift.end <= shift.start;
}

function isEveningShift(shift) {
  if (!shift) return false;
  return shift.start === "16:00" && shift.end === "00:00";
}

function getEmployeeLeaveRequests(employeeId) {
  return state.leaveRequests
    .filter((request) => request.employeeId === employeeId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function renderEmployeeLeaveStatus(employeeId) {
  const requests = getEmployeeLeaveRequests(employeeId);
  if (!requests.length) {
    return `<p class="calendar-note">No leave request submitted.</p>`;
  }

  return `
    <div class="report-table-wrap leave-status-table-wrap">
      <table class="report-table report-table-compact leave-status-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Description</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${requests.map((request) => `
            <tr>
              <td>${formatDateLabel(request.date)}</td>
              <td>${renderAdminStatusChip(request.status)}</td>
              <td>${escapeHtml(request.reason)}</td>
              <td>${escapeHtml(request.description)}</td>
              <td>
                <div class="inline-actions">
                  <button type="button" class="ghost-button admin-table-btn" data-edit-leave-request="${request.id}">Edit</button>
                  ${request.status === "approved"
                    ? `<button type="button" class="secondary-button admin-table-btn" data-cancel-leave-request="${request.id}">Request Cancel</button>`
                    : `<button type="button" class="danger-button admin-table-btn" data-delete-leave-request="${request.id}">Delete</button>`}
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function canCheckIn(record) {
  return record.status !== "off" && record.status !== "leave-approved" && !record.checkInAt && !record.checkOutAt;
}

function canCheckOut(record) {
  return Boolean(record.checkInAt && !record.checkOutAt);
}

function isLateCheckIn(checkInAt, shiftStart) {
  if (!checkInAt || !shiftStart) return false;
  const checkIn = new Date(checkInAt);
  const [hour, minute] = shiftStart.split(":").map(Number);
  const shiftDate = new Date(checkIn);
  shiftDate.setHours(hour, minute, 0, 0);
  return (checkIn.getTime() - shiftDate.getTime()) > 15 * 60 * 1000;
}

function getDailyRecord(employeeId, dateKey) {
  const record = state.records[dateKey]?.[employeeId];
  if (!record) return {};
  if (typeof record.missedCheckoutAcknowledged !== "boolean") {
    record.missedCheckoutAcknowledged = false;
  }
  return record;
}

function ensureDailyRecord(employeeId, dateKey) {
  if (!state.records[dateKey]) state.records[dateKey] = {};
  if (!state.records[dateKey][employeeId]) state.records[dateKey][employeeId] = { checkInAt: null, checkOutAt: null, report: null, status: "absent", leaveRequest: null, offReason: null, missedCheckoutAcknowledged: false };
  return state.records[dateKey][employeeId];
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultState));
      return normalizeState(defaultState);
    }
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultState));
    return normalizeState(defaultState);
  }
}

function normalizeState(parsed) {
  return {
    shifts: Array.isArray(parsed.shifts) && parsed.shifts.length ? parsed.shifts : structuredClone(defaultState.shifts),
    employees: Array.isArray(parsed.employees) ? parsed.employees : structuredClone(defaultState.employees),
    adminPassword: typeof parsed.adminPassword === "string" && parsed.adminPassword ? parsed.adminPassword : defaultState.adminPassword,
    leaveReasons: Array.isArray(parsed.leaveReasons) && parsed.leaveReasons.length ? parsed.leaveReasons : structuredClone(defaultState.leaveReasons),
    offReasons: Array.isArray(parsed.offReasons) && parsed.offReasons.length ? parsed.offReasons : structuredClone(defaultState.offReasons),
    leaveRequests: Array.isArray(parsed.leaveRequests) ? parsed.leaveRequests : [],
    records: parsed.records && typeof parsed.records === "object" ? parsed.records : {}
  };
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  void syncStateToSupabase();
}

async function syncStateToSupabase() {
  if (!supabaseClient || syncInFlight) return;
  syncInFlight = true;
  try {
    const payload = normalizeState(state);
    const { error } = await supabaseClient
      .from("app_state")
      .upsert({ id: REMOTE_STATE_ROW_ID, data: payload }, { onConflict: "id" });
    if (error) {
      console.error("Supabase sync failed:", error.message);
    }
  } catch (error) {
    console.error("Supabase sync failed:", error);
  } finally {
    syncInFlight = false;
  }
}

async function bootstrapApp() {
  const localState = loadState();
  state = localState;
  renderAll();

  if (!supabaseClient) {
    console.warn("Supabase client is not available. Running in local mode.");
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from("app_state")
      .select("data")
      .eq("id", REMOTE_STATE_ROW_ID)
      .maybeSingle();

    if (error) {
      console.error("Supabase load failed:", error.message);
      return;
    }

    if (data?.data) {
      state = normalizeState(data.data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
    } else {
      await syncStateToSupabase();
    }

    await loadCloudBackups();
    startRemotePolling();
  } catch (error) {
    console.error("Supabase bootstrap failed:", error);
  }
}

function startRemotePolling() {
  if (!supabaseClient || remotePollHandle) return;
  remotePollHandle = window.setInterval(async () => {
    try {
      const { data, error } = await supabaseClient
        .from("app_state")
        .select("data")
        .eq("id", REMOTE_STATE_ROW_ID)
        .maybeSingle();
      if (error || !data?.data) return;
      const remoteState = JSON.stringify(normalizeState(data.data));
      const localState = JSON.stringify(normalizeState(state));
      if (remoteState !== localState) {
        state = JSON.parse(remoteState);
        localStorage.setItem(STORAGE_KEY, remoteState);
        renderAll();
      }
    } catch (error) {
      console.error("Supabase polling failed:", error);
    }
  }, 15000);
}

async function loadCloudBackups() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from("backup_snapshots")
      .select("id, label, data, created_at")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) {
      console.error("Backup load failed:", error.message);
      return;
    }
    cloudBackups = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Backup load failed:", error);
  }
}

async function createCloudBackup() {
  if (!supabaseClient) {
    return { ok: false, message: "Supabase is not connected." };
  }
  try {
    const payload = normalizeState(state);
    const { error } = await supabaseClient
      .from("backup_snapshots")
      .insert({
        label: `Backup ${new Date().toLocaleString()}`,
        data: payload
      });
    if (error) {
      return { ok: false, message: "Could not create cloud backup." };
    }
    await loadCloudBackups();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: "Could not create cloud backup." };
  }
}

function createDefaultState() {
  const nightId = createId("shift");
  const morningId = createId("shift");
  const eveningId = createId("shift");
  return {
    adminPassword: "admin123",
    shifts: [
      { id: nightId, name: "Night", start: "00:00", end: "08:00", dailyDepositTarget: 150, system: true },
      { id: morningId, name: "Morning", start: "08:00", end: "17:00", dailyDepositTarget: 250, system: true },
      { id: eveningId, name: "Evening", start: "16:00", end: "00:00", dailyDepositTarget: 220, system: true }
    ],
    employees: [
      { id: createId("emp"), name: "Ayesha Malik", pin: "1234", shiftId: morningId, color: "#2f6feb", targets: { newPlayers: 90, deposit: 6000 } },
      { id: createId("emp"), name: "Bilal Ahmed", pin: "4321", shiftId: eveningId, color: "#36c78b", targets: { newPlayers: 75, deposit: 5000 } }
    ],
    leaveReasons: structuredClone(DEFAULT_LEAVE_REASONS),
    offReasons: structuredClone(DEFAULT_OFF_REASONS),
    leaveRequests: [],
    records: {}
  };
}

function getEmployee(id) { return state.employees.find((employee) => employee.id === id); }
function getShift(id) { return state.shifts.find((shift) => shift.id === id); }
function getTodayKey() { return toDateKey(new Date()); }
function toDateKey(date) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"); }
function formatShiftWindow(shift) { return `${formatTimeLabel(shift.start)} to ${formatTimeLabel(shift.end)}`; }
function formatTimeLabel(value) { const [hourText, minuteText] = value.split(":"); let hour = Number(hourText); const minute = Number(minuteText); const suffix = hour >= 12 ? "PM" : "AM"; if (hour === 0) hour = 12; else if (hour > 12) hour -= 12; return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`; }
function formatShortTime(value) { return value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--"; }
function formatDateTime(value) { return value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "--"; }
function formatDateLabel(key) { const [year, month, day] = key.split("-").map(Number); return new Date(year, month - 1, day).toLocaleDateString([], { month: "short", day: "numeric" }); }
function formatReportDate(key) { const [year, month, day] = key.split("-").map(Number); return `${day}-${new Date(year, month - 1, day).toLocaleDateString([], { month: "long" })}-${year}`; }
function toTimeInputValue(value) { return value ? `${String(new Date(value).getHours()).padStart(2, "0")}:${String(new Date(value).getMinutes()).padStart(2, "0")}` : ""; }
function buildDateTimeForToday(timeValue) {
  const [hour, minute] = timeValue.split(":").map(Number);
  const now = new Date();
  now.setHours(hour, minute, 0, 0);
  return now.toISOString();
}
function formatCurrency(value) { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function formatPlainNumber(value) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value || 0)); }
function buildReportSummary(report) { if (!report) return "No progress submitted."; return `Msgs ${report.huntingMessagesSent || 0}, Requests ${report.huntingRequestsSent || 0}, Posting ${report.postingOnIds || 0}, IDs ${report.totalIds || 0}, Deposit ${formatCurrency(report.deposit || 0)}, New Players ${report.newPlayers || 0}, Total Players ${report.totalPlayers || 0}`; }
function buildWhatsAppReport(employee, report, totalPlayersOverride, reportDateKey = getTodayKey()) {
  const totalPlayers = totalPlayersOverride ?? report.totalPlayers ?? 0;
  return `📋 Daily Agent Report\n\nName: ${employee.name}\nDate: ${formatReportDate(reportDateKey)}\nHunting Messages Sent: ${report.huntingMessagesSent || 0}\nHunting Requests Sent: ${report.huntingRequestsSent || 0}\nPosting on IDs: ${report.postingOnIds || 0}\n\nDeposit: $${Number(report.deposit || 0).toFixed(2)}\nNew Players: ${report.newPlayers || 0}\nTotal Players: ${totalPlayers}`;
}
function createId(prefix) { return `${prefix}-${Math.random().toString(36).slice(2, 10)}`; }
function maskPin(pin) { return pin.replace(/\d/g, "*"); }
function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

void bootstrapApp();
