// Finance Tracker main JavaScript

// Global state
let state = {
  // cards: credit card accounts
  cards: [],
  // loans: personal loans or other debts
  loans: [],
  // transactions: income and expenses
  transactions: [],
  // goals: savings and emergency fund targets
  goals: [],
  // currency code
  currency: 'THB',
  // monthly budget available for debt repayment
  budget: 0,
  // selected payoff strategy (default avalanche)
  selectedStrategy: 'avalanche',
};

// Mapping of currency codes to symbols
const CURRENCY_SYMBOLS = {
  THB: '฿',
  USD: '$',
  EUR: '€',
};

// Format a numeric value with comma separators and two decimal places.
function formatCurrencyValue(value) {
  if (typeof value !== 'number' || isNaN(value)) return '0.00';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Variables to track editing state
// Bill functionality has been removed, so there is no editingBillId
// let editingBillId = null;
let editingCardId = null;
let editingLoanId = null;

// Chart instance for dashboard visuals
let dashboardChart = null;

// Chart instance for debt distribution doughnut
let debtDistributionChart = null;

// Chart instance for strategy payoff projection
let strategyChart = null;

/**
 * Estimate the number of months needed to pay off all debts using a specified strategy.
 * Strategies:
 *  - 'avalanche': allocate extra budget to the debt with highest interest rate first.
 *  - 'snowball': allocate extra budget to the debt with the smallest balance first.
 *
 * The calculation assumes a constant monthly budget equal to state.budget. Minimum payments
 * for each debt are taken from their current values (5% of card balance or installment amount,
 * loan monthly payment). Extra budget is allocated to one debt at a time according to
 * the chosen strategy. Once a debt is cleared, its minimum payment is freed up and becomes
 * part of the available budget in subsequent months. A naive interest accrual (rate/12) is
 * applied monthly. If the budget does not cover the sum of minimum payments, the function
 * returns null to indicate that payoff is impossible with the current budget.
 *
 * @param {string} strategy - 'avalanche', 'snowball', 'highest_balance' or 'due_date'
 * @returns {number|null} Estimated months to clear all debts or null if impossible
 */
function calculatePayoffMonths(strategy) {
  // Build deep copies of debts with current balances, rates and min payments
  const debts = [];
  state.cards.forEach((card) => {
    const rate = card.rate && card.rate > 0 ? card.rate : 0.2; // default 20% annual
    const minPayment = card.installments && card.installments > 0 ? card.installmentAmount : card.balance * 0.05;
    debts.push({
      balance: card.balance,
      rate: rate,
      minPayment: minPayment,
      originalMin: minPayment, // store for reallocation after payoff
      dueDate: card.dueDate ? new Date(card.dueDate) : null,
    });
  });
  state.loans.forEach((loan) => {
    debts.push({
      balance: loan.principal,
      rate: loan.rate || 0,
      minPayment: loan.monthlyPayment,
      originalMin: loan.monthlyPayment,
      dueDate: loan.dueDate ? new Date(loan.dueDate) : null,
    });
  });
  if (debts.length === 0) return 0;
  // Check if initial budget covers minimum payments
  const initialMinTotal = debts.reduce((sum, d) => sum + d.minPayment, 0);
  if (state.budget <= 0 || initialMinTotal > state.budget) {
    return null;
  }
  // Determine ordering function based on strategy
  const orderFunction = (a, b) => {
    switch (strategy) {
      case 'snowball':
        // smallest balance first
        return a.balance - b.balance;
      case 'highest_balance':
        // largest balance first
        return b.balance - a.balance;
      case 'due_date':
        {
          // earliest due date first; items without due dates go last
          const aDate = a.dueDate instanceof Date ? a.dueDate.getTime() : Infinity;
          const bDate = b.dueDate instanceof Date ? b.dueDate.getTime() : Infinity;
          return aDate - bDate;
        }
      case 'avalanche':
      default:
        // highest interest first
        return b.rate - a.rate;
    }
  };
  let months = 0;
  // Deep copy for working list
  const workDebts = debts.map((d) => ({ ...d }));
  const maxMonths = 600; // safety limit to avoid infinite loops
  while (true) {
    // Check if all debts are cleared
    const remainingDebts = workDebts.filter((d) => d.balance > 0.01);
    if (remainingDebts.length === 0) break;
    if (months > maxMonths) {
      // Too many iterations; assume payoff will take a very long time
      return null;
    }
    months++;
    // Sort remaining debts by strategy order
    remainingDebts.sort(orderFunction);
    // Compute minimum payment total for active debts
    let minTotal = 0;
    remainingDebts.forEach((d) => {
      minTotal += d.minPayment;
    });
    // Compute available extra budget (may grow as debts are cleared)
    let extra = state.budget - minTotal;
    if (extra < 0) {
      // Should not happen due to earlier check, but guard just in case
      return null;
    }
    // Identify the debt to receive extra payment (first in sorted order)
    const target = remainingDebts[0];
    // Pay each debt
    for (const d of remainingDebts) {
      // Determine payment amount: always pay at least minPayment, plus extra for target
      let payment = d.minPayment;
      if (d === target && extra > 0) {
        // Do not pay more than remaining balance + interest accrual
        // (approx: avoid overshoot by taking minimum of extra and (balance + interest))
        payment += extra;
      }
      // Apply interest (annual rate / 12) before payment
      const monthlyRate = d.rate / 12;
      const newBalance = d.balance * (1 + monthlyRate) - payment;
      d.balance = newBalance;
    }
    // Remove debts that have been paid off (balance <= 0)
    for (const d of workDebts) {
      if (d.balance <= 0) {
        // If this debt is cleared, free its min payment for future months
        // Freed payment will be captured in extra in the next iteration automatically because minTotal will drop
        d.balance = 0;
        d.minPayment = 0;
      }
    }
  }
  return months;
}

/**
 * Calculate the total remaining debt balance over time for a given strategy.
 * Returns an array where each element represents the sum of balances across all debts
 * at the end of each month until all debts are cleared or a safety limit is reached.
 * Uses the same simulation as calculatePayoffMonths with dynamic reallocation of freed payments.
 *
 * @param {string} strategy - payoff strategy ('avalanche', 'snowball', 'highest_balance', 'due_date')
 * @returns {number[]} Array of total balances per month
 */
function calculateBalanceOverTime(strategy) {
  // Deep copy of debts
  const debts = [];
  state.cards.forEach((card) => {
    const rate = card.rate && card.rate > 0 ? card.rate : 0.2;
    const minPayment = card.installments && card.installments > 0 ? card.installmentAmount : card.balance * 0.05;
    debts.push({
      balance: card.balance,
      rate: rate,
      minPayment: minPayment,
      dueDate: card.dueDate ? new Date(card.dueDate) : null,
    });
  });
  state.loans.forEach((loan) => {
    debts.push({
      balance: loan.principal,
      rate: loan.rate || 0,
      minPayment: loan.monthlyPayment,
      dueDate: loan.dueDate ? new Date(loan.dueDate) : null,
    });
  });
  if (debts.length === 0) return [];
  // Check if budget covers minimum payments; if not, return an array of the current total repeated once
  const initialMinTotal = debts.reduce((sum, d) => sum + d.minPayment, 0);
  if (state.budget <= 0 || initialMinTotal > state.budget) {
    const total = debts.reduce((sum, d) => sum + d.balance, 0);
    return [total];
  }
  // Set up strategy ordering comparator
  const orderFn = (a, b) => {
    switch (strategy) {
      case 'snowball':
        return a.balance - b.balance;
      case 'highest_balance':
        return b.balance - a.balance;
      case 'due_date': {
        const aDate = a.dueDate instanceof Date ? a.dueDate.getTime() : Infinity;
        const bDate = b.dueDate instanceof Date ? b.dueDate.getTime() : Infinity;
        return aDate - bDate;
      }
      case 'avalanche':
      default:
        return b.rate - a.rate;
    }
  };
  const history = [];
  const workDebts = debts.map((d) => ({ ...d }));
  const maxMonths = 600;
  let months = 0;
  while (months < maxMonths) {
    // Sum remaining balances
    const totalRemaining = workDebts.reduce((sum, d) => sum + (d.balance > 0 ? d.balance : 0), 0);
    history.push(totalRemaining);
    if (totalRemaining <= 0.01) break;
    months++;
    // Get active debts and sort
    const active = workDebts.filter((d) => d.balance > 0);
    active.sort(orderFn);
    // Compute minimum payments and extra
    let minTotal = 0;
    active.forEach((d) => {
      minTotal += d.minPayment;
    });
    let extra = state.budget - minTotal;
    if (extra < 0) extra = 0;
    const target = active[0];
    // Pay each debt
    for (const d of active) {
      let payment = d.minPayment;
      if (d === target && extra > 0) {
        payment += extra;
      }
      const monthlyRate = d.rate / 12;
      d.balance = d.balance * (1 + monthlyRate) - payment;
      if (d.balance < 0) {
        d.balance = 0;
        d.minPayment = 0;
      }
    }
  }
  return history;
}

/**
 * Generate an amortisation schedule for a given strategy. Each entry contains
 * the starting total debt balance, total payment made, total interest accrued,
 * and ending balance for each month.
 *
 * @param {string} strategy
 * @returns {Array<{month: number, start: number, payment: number, interest: number, end: number}>}
 */
function calculateBalanceSchedule(strategy) {
  // Prepare debts similarly to other calculators
  const debts = [];
  state.cards.forEach((card) => {
    const rate = card.rate && card.rate > 0 ? card.rate : 0.2;
    const minPayment = card.installments && card.installments > 0 ? card.installmentAmount : card.balance * 0.05;
    debts.push({
      balance: card.balance,
      rate: rate,
      minPayment: minPayment,
      dueDate: card.dueDate ? new Date(card.dueDate) : null,
    });
  });
  state.loans.forEach((loan) => {
    debts.push({
      balance: loan.principal,
      rate: loan.rate || 0,
      minPayment: loan.monthlyPayment,
      dueDate: loan.dueDate ? new Date(loan.dueDate) : null,
    });
  });
  const schedule = [];
  if (debts.length === 0) return schedule;
  // Check budget covers min payments
  const initialMinTotal = debts.reduce((sum, d) => sum + d.minPayment, 0);
  if (state.budget <= 0 || initialMinTotal > state.budget) {
    // If budget insufficient, schedule can't progress; return one line with initial state
    const total = debts.reduce((sum, d) => sum + d.balance, 0);
    schedule.push({ month: 1, start: total, payment: 0, interest: 0, end: total });
    return schedule;
  }
  // Determine ordering comparator
  const orderFn = (a, b) => {
    switch (strategy) {
      case 'snowball':
        return a.balance - b.balance;
      case 'highest_balance':
        return b.balance - a.balance;
      case 'due_date': {
        const aDate = a.dueDate instanceof Date ? a.dueDate.getTime() : Infinity;
        const bDate = b.dueDate instanceof Date ? b.dueDate.getTime() : Infinity;
        return aDate - bDate;
      }
      case 'avalanche':
      default:
        return b.rate - a.rate;
    }
  };
  // Work copy
  const workDebts = debts.map((d) => ({ ...d }));
  let month = 0;
  const maxMonths = 600;
  while (month < maxMonths) {
    month++;
    // Compute starting total
    const startTotal = workDebts.reduce((sum, d) => sum + (d.balance > 0 ? d.balance : 0), 0);
    if (startTotal <= 0.01) break;
    // Determine active debts and sort
    const active = workDebts.filter((d) => d.balance > 0);
    active.sort(orderFn);
    // Minimum total and extra
    let minTotal = 0;
    active.forEach((d) => {
      minTotal += d.minPayment;
    });
    let extra = state.budget - minTotal;
    if (extra < 0) extra = 0;
    const target = active[0];
    let totalInterest = 0;
    let totalPayment = 0;
    // Pay each debt
    active.forEach((d) => {
      const monthlyRate = d.rate / 12;
      const interest = d.balance * monthlyRate;
      totalInterest += interest;
      let payment = d.minPayment;
      if (d === target && extra > 0) {
        payment += extra;
      }
      totalPayment += payment;
      d.balance = d.balance + interest - payment;
      if (d.balance < 0) {
        d.balance = 0;
        d.minPayment = 0;
      }
    });
    const endTotal = workDebts.reduce((sum, d) => sum + (d.balance > 0 ? d.balance : 0), 0);
    schedule.push({ month: month, start: startTotal, payment: totalPayment, interest: totalInterest, end: endTotal });
    if (endTotal <= 0.01) break;
  }
  return schedule;
}

// Utility: load data from localStorage
function loadData() {
  try {
    const cards = JSON.parse(localStorage.getItem('cards'));
    const loans = JSON.parse(localStorage.getItem('loans'));
    const currency = localStorage.getItem('currency');
    const transactions = JSON.parse(localStorage.getItem('transactions'));
    const goals = JSON.parse(localStorage.getItem('goals'));
    const budgetVal = localStorage.getItem('budget');
    const storedStrategy = localStorage.getItem('strategy');
    state.cards = Array.isArray(cards) ? cards : [];
    state.loans = Array.isArray(loans) ? loans : [];
    state.transactions = Array.isArray(transactions) ? transactions : [];
    state.goals = Array.isArray(goals) ? goals : [];
    state.currency = currency || 'THB';
    const parsedBudget = parseFloat(budgetVal);
    state.budget = !isNaN(parsedBudget) && parsedBudget >= 0 ? parsedBudget : 0;
    state.selectedStrategy = storedStrategy || 'avalanche';
  } catch (err) {
    console.error('Error loading data from localStorage', err);
    // In case of any error, reset to default state
    state.cards = [];
    state.loans = [];
    state.currency = 'THB';
    state.budget = 0;
  }
}

// Utility: save cards to localStorage
function saveCards() {
  localStorage.setItem('cards', JSON.stringify(state.cards));
}

// Utility: save loans to localStorage
function saveLoans() {
  localStorage.setItem('loans', JSON.stringify(state.loans));
}

// Utility: save transactions to localStorage
function saveTransactions() {
  localStorage.setItem('transactions', JSON.stringify(state.transactions));
}

// Utility: save goals to localStorage
function saveGoals() {
  localStorage.setItem('goals', JSON.stringify(state.goals));
}

// Bills functionality has been removed from the application. Define a no-op
// saveBills() to prevent potential reference errors. In previous versions
// this function would persist bills to localStorage. Bills are no longer
// stored or displayed.
function saveBills() {
  // no bills to save
}

// Utility: save budget to localStorage
function saveBudget() {
  localStorage.setItem('budget', state.budget);
}

// Utility: save selected strategy to localStorage
function saveStrategy() {
  localStorage.setItem('strategy', state.selectedStrategy);
}

// Save selected currency
function saveCurrency() {
  localStorage.setItem('currency', state.currency);
}

// Navigation handling
function showSection(sectionId) {
  const sections = document.querySelectorAll('.section');
  sections.forEach((sec) => {
    sec.classList.remove('active');
  });
  const section = document.getElementById(sectionId);
  if (section) {
    section.classList.add('active');
  }
}

function setActiveLink(activeLink) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.remove('active');
  });
  activeLink.classList.add('active');
}

// Event handlers
// The application no longer supports bill tracking, so the bill
// submission handler has been removed. Leaving an empty function to avoid
// reference errors if called elsewhere.
function handleAddBill(e) {
  // Bills are deprecated. Nothing to do here.
  e.preventDefault();
}

function handleAddCard(e) {
  e.preventDefault();
  const name = document.getElementById('card-name').value.trim();
  const balance = parseFloat(document.getElementById('card-balance').value);
  const dueDate = document.getElementById('card-due-date').value;
  const installmentsVal = document.getElementById('card-installments').value;
  const installmentAmountVal = document.getElementById('card-installment-amount').value;
  const rateVal = document.getElementById('card-rate').value;
  if (!name || isNaN(balance) || !dueDate) return;
  let installments = parseInt(installmentsVal);
  let installmentAmount = parseFloat(installmentAmountVal);
  // Normalize NaN to zero
  installments = !isNaN(installments) && installments > 0 ? installments : 0;
  installmentAmount = !isNaN(installmentAmount) && installmentAmount > 0 ? installmentAmount : 0;
  const rate = parseFloat(rateVal);
  const interestRate = !isNaN(rate) && rate > 0 ? rate / 100 : 0;
  // Auto-calculate if one value is missing
  // Auto‑calculate missing values.  If the user enters only the number of
  // instalments (term) or only the instalment amount, compute the other using
  // the loan amortisation formula.  When an annual interest rate is supplied,
  // the monthly payment is calculated so that the card is paid off over the
  // given number of months.  If no interest rate is provided, fall back to
  // simple division of the balance by the instalment count.
  if (installments > 0 && installmentAmount <= 0) {
    if (interestRate > 0) {
      const monthlyRate = interestRate / 12;
      // payment = P * r / (1 - (1 + r)^(-n))
      installmentAmount = (balance * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -installments));
    } else {
      installmentAmount = balance / installments;
    }
  } else if (installmentAmount > 0 && installments <= 0) {
    if (interestRate > 0) {
      const monthlyRate = interestRate / 12;
      // Solve for n: n = -log(1 - (r * P)/payment) / log(1 + r)
      const ratio = 1 - (monthlyRate * balance) / installmentAmount;
      if (ratio <= 0) {
        installments = 1;
      } else {
        installments = Math.ceil(-Math.log(ratio) / Math.log(1 + monthlyRate));
      }
    } else {
      installments = Math.ceil(balance / installmentAmount);
    }
  }
  // Round the computed instalment amount to two decimal places for display
  installmentAmount = Math.round(installmentAmount * 100) / 100;
  if (editingCardId !== null) {
    // Update existing card
    const index = state.cards.findIndex((c) => c.id === editingCardId);
    if (index !== -1) {
      state.cards[index].name = name;
      state.cards[index].balance = balance;
      state.cards[index].dueDate = dueDate;
      state.cards[index].installments = installments;
      state.cards[index].installmentAmount = installmentAmount;
      state.cards[index].rate = interestRate;
    }
    editingCardId = null;
    document.querySelector('#card-form button[type="submit"]').textContent = 'Add Card';
  } else {
    const newCard = {
      id: Date.now(),
      name,
      balance,
      dueDate,
      installments,
      installmentAmount,
      rate: interestRate,
    };
    state.cards.push(newCard);
  }
  saveCards();
  renderCards();
  renderDashboard();
  renderInsights();
  document.getElementById('card-form').reset();
}

// Event handler for adding or updating a loan
function handleAddLoan(e) {
  e.preventDefault();
  const name = document.getElementById('loan-name').value.trim();
  const principal = parseFloat(document.getElementById('loan-principal').value);
  const rateVal = parseFloat(document.getElementById('loan-rate').value);
  const term = parseInt(document.getElementById('loan-term').value);
  const dueDate = document.getElementById('loan-due-date').value;
  if (!name || isNaN(principal) || principal <= 0 || isNaN(rateVal) || isNaN(term) || term <= 0) return;
  const annualRate = rateVal / 100;
  const monthlyRate = annualRate / 12;
  let monthlyPayment;
  if (monthlyRate === 0) {
    monthlyPayment = principal / term;
  } else {
    // EMI formula: P * r * (1+r)^n / ((1+r)^n - 1)
    const pow = Math.pow(1 + monthlyRate, term);
    monthlyPayment = (principal * monthlyRate * pow) / (pow - 1);
  }
  if (editingLoanId !== null) {
    const index = state.loans.findIndex((l) => l.id === editingLoanId);
    if (index !== -1) {
      state.loans[index].name = name;
      state.loans[index].principal = principal;
      state.loans[index].rate = annualRate;
      state.loans[index].term = term;
      state.loans[index].dueDate = dueDate;
      state.loans[index].monthlyPayment = monthlyPayment;
    }
    editingLoanId = null;
    document.querySelector('#loan-form button[type="submit"]').textContent = 'Add Loan';
  } else {
    const newLoan = {
      id: Date.now(),
      name,
      principal,
      rate: annualRate,
      term,
      dueDate,
      monthlyPayment,
    };
    state.loans.push(newLoan);
  }
  saveLoans();
  renderLoans();
  renderDashboard();
  renderInsights();
  document.getElementById('loan-form').reset();
}

// Event handler for adding a transaction (income or expense)
function handleAddTransaction(e) {
  e.preventDefault();
  const desc = document.getElementById('transaction-desc').value.trim();
  const amountVal = parseFloat(document.getElementById('transaction-amount').value);
  const date = document.getElementById('transaction-date').value;
  const type = document.getElementById('transaction-type').value;
  const category = document.getElementById('transaction-category').value.trim();
  if (!desc || isNaN(amountVal) || !date) return;
  // Positive amounts for income, negative for expenses
  const amount = type === 'expense' ? -Math.abs(amountVal) : Math.abs(amountVal);
  const newTx = {
    id: Date.now(),
    desc,
    amount,
    date,
    type,
    category,
  };
  state.transactions.push(newTx);
  saveTransactions();
  renderTransactions();
  renderInsights();
  // Reset form fields
  document.getElementById('transaction-form').reset();
}

// Event handler for adding a new savings goal
function handleAddGoal(e) {
  e.preventDefault();
  const name = document.getElementById('goal-name').value.trim();
  const targetVal = parseFloat(document.getElementById('goal-target').value);
  if (!name || isNaN(targetVal) || targetVal <= 0) return;
  const newGoal = {
    id: Date.now(),
    name,
    target: targetVal,
    saved: 0,
  };
  state.goals.push(newGoal);
  saveGoals();
  renderGoals();
  renderInsights();
  document.getElementById('goal-form').reset();
}

// Render the list of savings goals
function renderGoals() {
  const container = document.getElementById('goals-list');
  if (!container) return;
  container.innerHTML = '';
  if (!state.goals || state.goals.length === 0) {
    container.textContent = 'No savings goals yet.';
    return;
  }
  const ul = document.createElement('ul');
  state.goals.forEach((goal) => {
    const li = document.createElement('li');
    const currencySymbol = CURRENCY_SYMBOLS[state.currency] || '';
    const progress = goal.target > 0 ? (goal.saved / goal.target) * 100 : 0;
    const progressPercent = Math.min(progress, 100);
    li.innerHTML = `
      <div class="goal-header"><strong>${goal.name}</strong> – ${currencySymbol}${formatCurrencyValue(goal.saved)} of ${currencySymbol}${formatCurrencyValue(goal.target)}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${progressPercent}%"></div></div>
      <div class="goal-actions">
        <input type="number" min="0.01" step="0.01" placeholder="Add amount" id="contrib-${goal.id}" />
        <button data-id="${goal.id}" class="add-contribution">Add Contribution</button>
        <button data-id="${goal.id}" class="delete-goal">Delete</button>
      </div>
    `;
    ul.appendChild(li);
  });
  container.appendChild(ul);
  // Event listeners for contribution and deletion
  container.querySelectorAll('.add-contribution').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      const id = parseInt(event.target.getAttribute('data-id'));
      const input = document.getElementById('contrib-' + id);
      const val = parseFloat(input.value);
      if (!isNaN(val) && val > 0) {
        const goal = state.goals.find((g) => g.id === id);
        if (goal) {
          goal.saved += val;
          saveGoals();
          renderGoals();
          renderInsights();
          input.value = '';
        }
      }
    });
  });
  container.querySelectorAll('.delete-goal').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      const id = parseInt(event.target.getAttribute('data-id'));
      state.goals = state.goals.filter((g) => g.id !== id);
      saveGoals();
      renderGoals();
      renderInsights();
    });
  });
}

// Render the list of transactions
function renderTransactions() {
  const list = document.getElementById('transactions-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.transactions || state.transactions.length === 0) {
    list.textContent = 'No transactions recorded yet.';
    return;
  }
  const ul = document.createElement('ul');
  state.transactions.forEach((tx) => {
    const li = document.createElement('li');
    const currencySymbol = CURRENCY_SYMBOLS[state.currency] || '';
    const amountFormatted = formatCurrencyValue(Math.abs(tx.amount));
    const sign = tx.amount < 0 ? '-' : '';
    const categoryText = tx.category ? ` (${tx.category})` : '';
    li.innerHTML = `<strong>${tx.desc}</strong> – ${tx.date} – ${sign}${currencySymbol}${amountFormatted}${categoryText}`;
    ul.appendChild(li);
  });
  list.appendChild(ul);
}

function toggleBillPaid(id) {
  // Bill functionality has been removed; toggling paid status is unsupported.
}

// Edit bill: prefill form and set editing state
function handleEditBill(id) {
  // Bill functionality has been removed; editing bills is no longer supported.
}

// Edit card: prefill form and set editing state
function handleEditCard(id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return;
  editingCardId = id;
  document.getElementById('card-name').value = card.name;
  document.getElementById('card-balance').value = card.balance;
  document.getElementById('card-due-date').value = card.dueDate;
  document.getElementById('card-installments').value = card.installments || '';
  document.getElementById('card-installment-amount').value = card.installmentAmount || '';
  document.querySelector('#card-form button[type="submit"]').textContent = 'Update Card';
  showSection('cards');
  setActiveLink(document.querySelector('.nav-link[data-section="cards"]'));
}

// Edit loan: prefill form and set editing state
function handleEditLoan(id) {
  const loan = state.loans.find((l) => l.id === id);
  if (!loan) return;
  editingLoanId = id;
  document.getElementById('loan-name').value = loan.name;
  document.getElementById('loan-principal').value = loan.principal;
  document.getElementById('loan-rate').value = (loan.rate * 100).toFixed(2);
  document.getElementById('loan-term').value = loan.term;
  document.getElementById('loan-due-date').value = loan.dueDate || '';
  document.querySelector('#loan-form button[type="submit"]').textContent = 'Update Loan';
  showSection('loans');
  setActiveLink(document.querySelector('.nav-link[data-section="loans"]'));
}

function deleteBill(id) {
  // Bill functionality has been removed; deleting bills is no longer supported.
}

function deleteCard(id) {
  state.cards = state.cards.filter((c) => c.id !== id);
  saveCards();
  renderCards();
  renderDashboard();
}

// Delete a loan and refresh relevant UI
function deleteLoan(id) {
  state.loans = state.loans.filter((l) => l.id !== id);
  saveLoans();
  renderLoans();
  renderDashboard();
  renderInsights();
}

// Rendering functions
function renderBills() {
  // Bills have been removed from the application. If a container exists, clear it and show a notice.
  const container = document.getElementById('bills-list');
  if (container) {
    container.innerHTML = '<p>Bills are not supported in this version.</p>';
  }
}

function renderCards() {
  const container = document.getElementById('cards-list');
  container.innerHTML = '';
  if (state.cards.length === 0) {
    container.innerHTML = '<p>No cards added yet.</p>';
    return;
  }
  // Sort cards by due date ascending
  const sorted = [...state.cards].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  sorted.forEach((card) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const info = document.createElement('div');
    info.className = 'item-info';
    const due = new Date(card.dueDate);
    const today = new Date();
    let statusClass = '';
    if (due < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
      statusClass = 'overdue';
    } else {
      const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
      if (diffDays <= 7) statusClass = 'upcoming';
    }
    const currencySymbol = CURRENCY_SYMBOLS[state.currency] || '';
    info.innerHTML = `<strong>${card.name}</strong><br />`
      + `Balance: ${currencySymbol}${formatCurrencyValue(card.balance)} – Due: <span class="${statusClass}">${card.dueDate}</span>`;
    // Show installments if present
    if (card.installments && card.installments > 0) {
      info.innerHTML += `<br /><small>Installments: ${card.installments} months, ${currencySymbol}${formatCurrencyValue(card.installmentAmount)} per month</small>`;
    }
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => handleEditCard(card.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteCard(card.id));
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(info);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

// Render loans list
function renderLoans() {
  const container = document.getElementById('loans-list');
  if (!container) return;
  container.innerHTML = '';
  if (state.loans.length === 0) {
    container.innerHTML = '<p>No loans added yet.</p>';
    return;
  }
  // Sort loans by due date if available
  const sorted = [...state.loans].sort((a, b) => {
    const aDate = a.dueDate ? new Date(a.dueDate) : new Date('9999-12-31');
    const bDate = b.dueDate ? new Date(b.dueDate) : new Date('9999-12-31');
    return aDate - bDate;
  });
  const today = new Date();
  sorted.forEach((loan) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const info = document.createElement('div');
    info.className = 'item-info';
    let statusClass = '';
    if (loan.dueDate) {
      const due = new Date(loan.dueDate);
      if (due < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
        statusClass = 'overdue';
      } else {
        const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
        if (diffDays <= 7) statusClass = 'upcoming';
      }
    }
    const currencySymbol = CURRENCY_SYMBOLS[state.currency] || '';
    info.innerHTML = `<strong>${loan.name}</strong><br />` +
      `${currencySymbol}${formatCurrencyValue(loan.principal)} – ` +
      `Monthly: ${currencySymbol}${formatCurrencyValue(loan.monthlyPayment)}` +
      (loan.dueDate ? ` – Due: <span class="${statusClass}">${loan.dueDate}</span>` : '');
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => handleEditLoan(loan.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteLoan(loan.id));
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(info);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

function renderDashboard() {
  const summary = document.getElementById('summary');
  summary.innerHTML = '';
  // Compute upcoming and overdue payment counts and amounts for cards and loans
  const today = new Date();
  let upcomingCount = 0;
  let overdueCount = 0;
  let upcomingAmount = 0;
  let overdueAmount = 0;
  // Helper to get truncated date for comparison
  const truncateDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // For cards
  state.cards.forEach((card) => {
    const dueDate = card.dueDate ? new Date(card.dueDate) : null;
    const payment = card.installments && card.installments > 0 ? card.installmentAmount : card.balance * 0.05;
    if (dueDate) {
      if (dueDate < truncateDate) {
        overdueCount++;
        overdueAmount += payment;
      } else {
        const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= 7) {
          upcomingCount++;
          upcomingAmount += payment;
        }
      }
    }
  });
  // For loans
  state.loans.forEach((loan) => {
    const dueDate = loan.dueDate ? new Date(loan.dueDate) : null;
    const payment = loan.monthlyPayment;
    if (dueDate) {
      if (dueDate < truncateDate) {
        overdueCount++;
        overdueAmount += payment;
      } else {
        const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= 7) {
          upcomingCount++;
          upcomingAmount += payment;
        }
      }
    }
  });
  // Total balances
  const totalCardBalance = state.cards.reduce((sum, c) => sum + c.balance, 0);
  const totalLoanBalance = state.loans.reduce((sum, l) => sum + l.principal, 0);
  // Total minimum payments
  const totalCardMin = state.cards.reduce((sum, c) => {
    const payment = c.installments && c.installments > 0 ? c.installmentAmount : c.balance * 0.05;
    return sum + payment;
  }, 0);
  const totalLoanMin = state.loans.reduce((sum, l) => sum + l.monthlyPayment, 0);
  const totalMinPayments = totalCardMin + totalLoanMin;
  const currencySymbol = CURRENCY_SYMBOLS[state.currency] || '';
  // Summary cards
  const summaryCards = [
    {
      title: 'Upcoming Payments (next 7 days)',
      value: `${upcomingCount} payment${upcomingCount === 1 ? '' : 's'}`,
      amount: upcomingAmount,
    },
    {
      title: 'Overdue Payments',
      value: `${overdueCount} payment${overdueCount === 1 ? '' : 's'}`,
      amount: overdueAmount,
    },
    {
      title: 'Total Debt Balance',
      value: `${currencySymbol}${formatCurrencyValue(totalCardBalance + totalLoanBalance)}`,
      amount: totalCardBalance + totalLoanBalance,
    },
    {
      title: 'Min Payment',
      value: `${currencySymbol}${formatCurrencyValue(totalMinPayments)}`,
      amount: totalMinPayments,
    },
  ];
  summaryCards.forEach((c) => {
    const cardEl = document.createElement('div');
    cardEl.className = 'summary-card';
    cardEl.innerHTML = `<h3>${c.title}</h3><p>${c.value}</p>`;
    // Show amount for upcoming and overdue cards
    if ((c.title.startsWith('Upcoming') || c.title.startsWith('Overdue')) && c.amount > 0) {
      cardEl.innerHTML += `<small style="color: #555">${currencySymbol}${formatCurrencyValue(c.amount)}</small>`;
    }
    summary.appendChild(cardEl);
  });
  // Compute recommended payments if budget provided
  const recommendationsDiv = document.getElementById('recommendations');
  if (recommendationsDiv) {
    recommendationsDiv.innerHTML = '<h3>Payment Recommendations</h3>';
    // Build list of debts with properties needed for recommendations
    const debts = [];
    state.cards.forEach((card) => {
      const interest = card.rate ? card.rate : 0.2; // default 20% if unspecified
      const minPayment = card.installments && card.installments > 0 ? card.installmentAmount : card.balance * 0.05;
      debts.push({ id: card.id, type: 'card', name: card.name, interest, minPayment, balance: card.balance, dueDate: card.dueDate ? new Date(card.dueDate) : null });
    });
    state.loans.forEach((loan) => {
      const interest = loan.rate || 0;
      const minPayment = loan.monthlyPayment;
      debts.push({ id: loan.id, type: 'loan', name: loan.name, interest, minPayment, balance: loan.principal, dueDate: loan.dueDate ? new Date(loan.dueDate) : null });
    });
    if (debts.length === 0) {
      recommendationsDiv.innerHTML += '<p>No debts to recommend payments for.</p>';
    } else {
      // Determine sorting based on selected strategy
      const strategy = state.selectedStrategy || 'avalanche';
      const sortFn = (a, b) => {
        switch (strategy) {
          case 'snowball':
            return a.balance - b.balance;
          case 'highest_balance':
            return b.balance - a.balance;
          case 'due_date': {
            const aDate = a.dueDate instanceof Date ? a.dueDate.getTime() : Infinity;
            const bDate = b.dueDate instanceof Date ? b.dueDate.getTime() : Infinity;
            return aDate - bDate;
          }
          case 'avalanche':
          default:
            return b.interest - a.interest;
        }
      };
      debts.sort(sortFn);
      const totalMin = debts.reduce((sum, d) => sum + d.minPayment, 0);
      let extraBudget = state.budget - totalMin;
      if (isNaN(extraBudget)) extraBudget = 0;
      if (extraBudget < 0) extraBudget = 0;
      const recommendedPayments = debts.map((d, index) => {
        let extra = 0;
        if (index === 0 && extraBudget > 0) {
          extra = Math.min(extraBudget, d.balance - d.minPayment);
        }
        const payment = d.minPayment + extra;
        return { name: d.name, payment: payment, minPayment: d.minPayment };
      });
      // Display recommended payments
      recommendedPayments.forEach((rec) => {
        const p = document.createElement('p');
        p.textContent = `${rec.name}: ${currencySymbol}${formatCurrencyValue(rec.payment)} (min: ${currencySymbol}${formatCurrencyValue(rec.minPayment)})`;
        recommendationsDiv.appendChild(p);
      });
      // Show if budget exceeds total payments
      const footer = document.createElement('p');
      footer.style.fontStyle = 'italic';
      footer.style.fontSize = '0.85rem';
      footer.textContent = `Total min payments: ${currencySymbol}${formatCurrencyValue(totalMin)}; Budget: ${currencySymbol}${formatCurrencyValue(state.budget)}`;
      recommendationsDiv.appendChild(footer);
    }
  }

  // Render chart
  const ctx = document.getElementById('dashboard-chart');
  if (ctx) {
    // Prepare chart data. Display upcoming and overdue payment totals, card and loan balances,
    // total minimum payments, and the user's budget to provide a clear picture of the debt landscape.
    const chartData = {
      labels: ['Upcoming', 'Overdue', 'Card Balance', 'Loan Balance', 'Min Payment', 'Budget'],
      datasets: [
        {
          label: 'Amount',
          data: [
            upcomingAmount,
            overdueAmount,
            totalCardBalance,
            totalLoanBalance,
            totalMinPayments,
            state.budget,
          ],
          backgroundColor: [
            // upcoming
            getComputedStyle(document.documentElement).getPropertyValue('--warning-color').trim(),
            // overdue
            getComputedStyle(document.documentElement).getPropertyValue('--danger-color').trim(),
            // card balance
            getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim(),
            // loan balance
            getComputedStyle(document.documentElement).getPropertyValue('--primary-dark').trim(),
            // min payment
            getComputedStyle(document.documentElement).getPropertyValue('--success-color').trim(),
            // budget
            getComputedStyle(document.documentElement).getPropertyValue('--muted-text').trim(),
          ],
        },
      ],
    };
    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.dataset.data[context.dataIndex];
              return `${currencySymbol}${formatCurrencyValue(value)}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (value) => `${currencySymbol}${formatCurrencyValue(value)}`,
          },
        },
      },
    };
    if (dashboardChart) {
      dashboardChart.destroy();
    }
    const context = ctx.getContext('2d');
    dashboardChart = new Chart(context, { type: 'bar', data: chartData, options: chartOptions });
  }

  // Render debt distribution doughnut chart (cards vs loans)
  const distCanvas = document.getElementById('debt-distribution-chart');
  if (distCanvas) {
    const distData = {
      labels: ['Cards', 'Loans'],
      datasets: [
        {
          data: [totalCardBalance, totalLoanBalance],
          backgroundColor: [
            getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim(),
            getComputedStyle(document.documentElement).getPropertyValue('--primary-dark').trim(),
          ],
        },
      ],
    };
    const distOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            boxWidth: 12,
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.dataset.data[context.dataIndex];
              return `${context.label}: ${currencySymbol}${formatCurrencyValue(value)}`;
            },
          },
        },
      },
    };
    if (debtDistributionChart) {
      debtDistributionChart.destroy();
    }
    const distCtx = distCanvas.getContext('2d');
    debtDistributionChart = new Chart(distCtx, { type: 'doughnut', data: distData, options: distOptions });
  }

  // Update budget usage progress bar
  const progressContainer = document.getElementById('budget-usage-container');
  if (progressContainer) {
    const progressBar = document.getElementById('budget-progress');
    const usageText = document.getElementById('budget-usage-text');
    if (progressBar && usageText) {
      if (state.budget && state.budget > 0) {
        const usageRatio = totalMinPayments / state.budget;
        const percent = Math.min(usageRatio * 100, 100);
        progressBar.style.width = `${percent.toFixed(1)}%`;
        if (usageRatio > 1) {
          progressBar.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--danger-color').trim();
        } else if (usageRatio > 0.75) {
          progressBar.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--warning-color').trim();
        } else {
          progressBar.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim();
        }
        const remaining = state.budget - totalMinPayments;
        if (remaining < 0) {
          usageText.textContent = `Minimum payments exceed your budget by ${currencySymbol}${formatCurrencyValue(Math.abs(remaining))}`;
        } else {
          usageText.textContent = `Using ${currencySymbol}${formatCurrencyValue(totalMinPayments)} of ${currencySymbol}${formatCurrencyValue(state.budget)} budget`;
        }
      } else {
        progressBar.style.width = '0%';
        usageText.textContent = 'Set a monthly budget to see usage';
      }
    }
  }

  // Add payoff strategy analysis (avalanche vs snowball)
  if (recommendationsDiv) {
    // Append analysis of payoff strategies if there are debts and budget covers min payments
    const existingParagraphs = recommendationsDiv.querySelectorAll('.strategy-analysis');
    existingParagraphs.forEach((el) => el.remove());
    const debtsExist = state.cards.length > 0 || state.loans.length > 0;
    const totalMinPaymentsCovered = state.budget >= 0 && state.budget >= totalMinPayments;
    if (debtsExist && totalMinPaymentsCovered) {
      // Calculate payoff months using avalanche and snowball strategies
      const avalancheMonths = calculatePayoffMonths('avalanche');
      const snowballMonths = calculatePayoffMonths('snowball');
      const highestBalanceMonths = calculatePayoffMonths('highest_balance');
      const dueDateMonths = calculatePayoffMonths('due_date');
      const analysisEl = document.createElement('div');
      analysisEl.className = 'strategy-analysis';
      analysisEl.innerHTML = '<h4>Payoff Strategy Comparison</h4>';
      const para1 = document.createElement('p');
      para1.innerHTML = `Using the <strong>avalanche method</strong> (highest interest first), you could clear your debts in <strong>${avalancheMonths === null ? '∞' : avalancheMonths}</strong> month${avalancheMonths === 1 ? '' : 's'}. This method minimizes the total interest paid.`;
      const para2 = document.createElement('p');
      para2.innerHTML = `Using the <strong>snowball method</strong> (smallest balance first), you could clear your debts in <strong>${snowballMonths === null ? '∞' : snowballMonths}</strong> month${snowballMonths === 1 ? '' : 's'}. This method provides quicker wins to keep you motivated.`;
      const para3 = document.createElement('p');
      para3.innerHTML = `Using the <strong>highest balance first</strong> method, you could clear your debts in <strong>${highestBalanceMonths === null ? '∞' : highestBalanceMonths}</strong> month${highestBalanceMonths === 1 ? '' : 's'}. This method tackles your largest obligations upfront.`;
      const para4 = document.createElement('p');
      para4.innerHTML = `Using the <strong>due date first</strong> method (earliest due date first), you could clear your debts in <strong>${dueDateMonths === null ? '∞' : dueDateMonths}</strong> month${dueDateMonths === 1 ? '' : 's'}. This method helps avoid missed payments.`;
      analysisEl.appendChild(para1);
      analysisEl.appendChild(para2);
      analysisEl.appendChild(para3);
      analysisEl.appendChild(para4);
      recommendationsDiv.appendChild(analysisEl);
    } else if (debtsExist && !totalMinPaymentsCovered) {
      const warn = document.createElement('p');
      warn.className = 'strategy-analysis';
      warn.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger-color').trim();
      warn.textContent = 'Your budget does not cover the minimum payments. Please increase your budget or adjust debts.';
      recommendationsDiv.appendChild(warn);
    }
  }

  // Reschedule notifications whenever the dashboard is rendered to account for updated due dates
  scheduleNotifications();

  // Render payoff projection chart for selected strategy
  const stratCanvas = document.getElementById('strategy-chart');
  if (stratCanvas) {
    const history = calculateBalanceOverTime(state.selectedStrategy);
    const labels = history.map((_, idx) => `Month ${idx + 1}`);
    const stratData = {
      labels: labels,
      datasets: [
        {
          label: 'Total Debt Balance',
          data: history,
          borderColor: getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim(),
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim(),
          fill: false,
          tension: 0.2,
        },
      ],
    };
    const stratOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.dataset.data[context.dataIndex];
              return `${currencySymbol}${formatCurrencyValue(value)}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (value) => `${currencySymbol}${formatCurrencyValue(value)}`,
          },
        },
      },
    };
    if (strategyChart) {
      strategyChart.destroy();
    }
    const stratCtx = stratCanvas.getContext('2d');
    strategyChart = new Chart(stratCtx, { type: 'line', data: stratData, options: stratOptions });
  }

  // Render amortisation schedule table
  const scheduleTableBody = document.querySelector('#schedule-table tbody');
  if (scheduleTableBody) {
    scheduleTableBody.innerHTML = '';
    // Generate schedule for current strategy
    const schedule = calculateBalanceSchedule(state.selectedStrategy);
    // Limit rows to a reasonable number to avoid huge table (e.g., show first 36 months)
    const maxRows = 36;
    schedule.slice(0, maxRows).forEach((row) => {
      const tr = document.createElement('tr');
      const monthTd = document.createElement('td');
      monthTd.textContent = row.month;
      const startTd = document.createElement('td');
      startTd.textContent = `${currencySymbol}${formatCurrencyValue(row.start)}`;
      const paymentTd = document.createElement('td');
      paymentTd.textContent = `${currencySymbol}${formatCurrencyValue(row.payment)}`;
      const interestTd = document.createElement('td');
      interestTd.textContent = `${currencySymbol}${formatCurrencyValue(row.interest)}`;
      const endTd = document.createElement('td');
      endTd.textContent = `${currencySymbol}${formatCurrencyValue(row.end)}`;
      tr.appendChild(monthTd);
      tr.appendChild(startTd);
      tr.appendChild(paymentTd);
      tr.appendChild(interestTd);
      tr.appendChild(endTd);
      scheduleTableBody.appendChild(tr);
    });
  }
}

function renderInsights() {
  const insightsDiv = document.getElementById('insights-content');
  insightsDiv.innerHTML = '';
  // Insights for debt management: show aggregated balances and minimum payments for cards and loans.
  const totalCardBalance = state.cards.reduce((sum, c) => sum + c.balance, 0);
  const totalLoanBalance = state.loans.reduce((sum, l) => sum + l.principal, 0);
  // Minimum payments: 5% of card balance or installment amount, plus loan monthly payments
  const totalCardMin = state.cards.reduce((sum, c) => {
    const payment = c.installments && c.installments > 0 ? c.installmentAmount : c.balance * 0.05;
    return sum + payment;
  }, 0);
  const totalLoanMin = state.loans.reduce((sum, l) => sum + l.monthlyPayment, 0);
  const totalMinPayments = totalCardMin + totalLoanMin;
  const currencySymbol = CURRENCY_SYMBOLS[state.currency] || '';
  const totalDebt = totalCardBalance + totalLoanBalance;
  // Calculate cash flow from transactions
  const totalIncome = state.transactions.reduce((sum, t) => sum + (t.amount > 0 ? t.amount : 0), 0);
  const totalExpenses = state.transactions.reduce((sum, t) => sum + (t.amount < 0 ? t.amount : 0), 0);
  // Build the insights HTML
  let html = '';
  html += `<p><strong>Total Card Balance:</strong> ${currencySymbol}${formatCurrencyValue(totalCardBalance)}</p>`;
  html += `<p><strong>Total Loan Balance:</strong> ${currencySymbol}${formatCurrencyValue(totalLoanBalance)}</p>`;
  html += `<p><strong>Total Debt:</strong> ${currencySymbol}${formatCurrencyValue(totalDebt)}</p>`;
  html += `<p><strong>Total Minimum Payment:</strong> ${currencySymbol}${formatCurrencyValue(totalMinPayments)}</p>`;
  if (state.budget && state.budget > 0) {
    html += `<p><strong>Budget for Debt Repayment:</strong> ${currencySymbol}${formatCurrencyValue(state.budget)}</p>`;
    const extra = state.budget - totalMinPayments;
    if (extra > 0) {
      html += `<p><em>You have ${currencySymbol}${formatCurrencyValue(extra)} extra beyond minimum payments.</em></p>`;
    } else {
      html += `<p><em>Your budget covers the minimum payments.</em></p>`;
    }
  }
  // Append income and expense summaries
  html += `<p><strong>Total Income:</strong> ${currencySymbol}${formatCurrencyValue(totalIncome)}</p>`;
  html += `<p><strong>Total Expenses:</strong> ${currencySymbol}${formatCurrencyValue(Math.abs(totalExpenses))}</p>`;
  const net = totalIncome + totalExpenses;
  const netLabel = net >= 0 ? 'Net Cash Flow' : 'Net Cash Flow';
  html += `<p><strong>${netLabel}:</strong> ${currencySymbol}${formatCurrencyValue(net)}</p>`;

  // Append savings summary
  if (state.goals && state.goals.length > 0) {
    const totalSavings = state.goals.reduce((sum, g) => sum + g.saved, 0);
    html += `<p><strong>Total Savings:</strong> ${currencySymbol}${formatCurrencyValue(totalSavings)}</p>`;
  }
  insightsDiv.innerHTML = html;
}

// Register service worker if supported
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  }
}

// Request notification permission
function requestNotificationPermission() {
  return new Promise((resolve) => {
    if (!('Notification' in window)) {
      resolve();
      return;
    }
    if (Notification.permission === 'granted') {
      resolve();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().finally(() => resolve());
    } else {
      // denied
      resolve();
    }
  });
}

// Schedule notifications for payments due soon (24 hours before due date)
function scheduleNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }
  const oneDayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  // Cancel any previously scheduled timeouts by storing handles? Not implemented; this is simplistic.
  // Schedule card notifications
  state.cards.forEach((card) => {
    if (card.dueDate) {
      const dueTime = new Date(card.dueDate).getTime();
      const notifyTime = dueTime - oneDayMs - now;
      if (notifyTime > 0) {
        setTimeout(() => {
          new Notification('Payment Reminder', {
            body: `${card.name} payment is due on ${card.dueDate}.`,
          });
        }, notifyTime);
      }
    }
  });
  // Schedule loan notifications
  state.loans.forEach((loan) => {
    if (loan.dueDate) {
      const dueTime = new Date(loan.dueDate).getTime();
      const notifyTime = dueTime - oneDayMs - now;
      if (notifyTime > 0) {
        setTimeout(() => {
          new Notification('Payment Reminder', {
            body: `${loan.name} payment is due on ${loan.dueDate}.`,
          });
        }, notifyTime);
      }
    }
  });
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  // Navigation events
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = link.getAttribute('data-section');
      showSection(sectionId);
      setActiveLink(link);
    });
  });
  // Form submissions
  // Bill form is no longer present; only set up handlers for cards and loans
  const cardForm = document.getElementById('card-form');
  if (cardForm) cardForm.addEventListener('submit', handleAddCard);
  const loanForm = document.getElementById('loan-form');
  if (loanForm) loanForm.addEventListener('submit', handleAddLoan);

  // Transaction form handler
  const transactionForm = document.getElementById('transaction-form');
  if (transactionForm) transactionForm.addEventListener('submit', handleAddTransaction);

  // Goal form handler
  const goalForm = document.getElementById('goal-form');
  if (goalForm) goalForm.addEventListener('submit', handleAddGoal);
  // Currency selector change handler
  const currencySelect = document.getElementById('currency-selector');
  if (currencySelect) {
    // Set initial value based on state
    currencySelect.value = state.currency;
      currencySelect.addEventListener('change', (e) => {
      state.currency = e.target.value;
      saveCurrency();
      // Re-render all UI with new currency
      renderDashboard();
      renderCards();
      renderInsights();
      renderLoans();
      renderTransactions();
      renderGoals();
    });
  }

  // Budget input handler
  const budgetInput = document.getElementById('budget-input');
  if (budgetInput) {
    // Set initial value with comma separators
    budgetInput.value = formatCurrencyValue(state.budget);
    // On input, format the value with comma separators without updating state
    budgetInput.addEventListener('input', (e) => {
      // Remove any non-digit or non-decimal characters except comma
      const raw = e.target.value.replace(/,/g, '');
      const numeric = parseFloat(raw);
      if (!isNaN(numeric)) {
        // Limit to two decimal places
        e.target.value = formatCurrencyValue(numeric);
      } else {
        // Allow empty input
        e.target.value = raw;
      }
    });
    // On change (blur), parse the number, update state and save
    budgetInput.addEventListener('change', (e) => {
      const raw = e.target.value.replace(/,/g, '');
      const val = parseFloat(raw);
      state.budget = !isNaN(val) && val >= 0 ? val : 0;
      saveBudget();
      // Set formatted value after update
      e.target.value = formatCurrencyValue(state.budget);
      renderDashboard();
      renderInsights();
    });
  }

  // Strategy selector handler
  const strategySelect = document.getElementById('strategy-selector');
  if (strategySelect) {
    // Set initial value
    strategySelect.value = state.selectedStrategy;
    strategySelect.addEventListener('change', (e) => {
      const val = e.target.value;
      state.selectedStrategy = val;
      saveStrategy();
      // Re-render dashboard with new strategy
      renderDashboard();
    });
  }
  // Render initial state
  renderDashboard();
  renderCards();
  renderLoans();
  renderInsights();
  renderTransactions();
  renderGoals();

  // Register service worker for PWA capabilities
  registerServiceWorker();
  // Request permission and schedule notifications for upcoming payments
  requestNotificationPermission().then(() => {
    scheduleNotifications();
  });
});