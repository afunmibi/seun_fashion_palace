import { useCallback, useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where
} from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import { auth, db } from './firebase';
import segoeUiTtfUrl from './assets/fonts/segoeui.ttf';
import './styles.css';

const COMPANY_NAME = 'Divine Glorious Enterprises';
const COMPANY_PHONE = '09168322622';
const COMPANY_ADDRESS = 'Kobape, Abeokuta, Ogun State';
const COMPANY_FILE_PREFIX = 'Divine-Glorious-receipt';
const FIREBASE_SAVE_TIMEOUT_MS = 12000;
const PENDING_SALES_STORAGE_KEY = 'dge_pending_sales_v1';
const NUMBER_FORMATTER = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const createProduct = () => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name: '',
  amount: '',
  qty: 1
});

const safeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatCurrency = (value) => {
  const amount = safeNumber(value);
  const formatted = NUMBER_FORMATTER.format(Math.abs(amount));
  return amount < 0 ? `-\u20A6${formatted}` : `\u20A6${formatted}`;
};

const toFileSlug = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const getPendingSalesStorageKey = (uid) => `${PENDING_SALES_STORAGE_KEY}_${uid || 'guest'}`;

const withTimeout = (promise, timeoutMs) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Firebase save timed out.')), timeoutMs);
    })
  ]);

const arrayBufferToBase64 = (buffer) => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

let pdfFontBase64Promise = null;

const loadPdfFontBase64 = async () => {
  if (!pdfFontBase64Promise) {
    pdfFontBase64Promise = fetch(segoeUiTtfUrl)
      .then((response) => response.arrayBuffer())
      .then((buffer) => arrayBufferToBase64(buffer));
  }

  return pdfFontBase64Promise;
};

const applyPdfUnicodeFont = async (doc) => {
  try {
    const fontBase64 = await loadPdfFontBase64();
    const fontFileName = 'SegoeUI.ttf';
    const fontFamily = 'SegoeUI';

    doc.addFileToVFS(fontFileName, fontBase64);
    doc.addFont(fontFileName, fontFamily, 'normal');
    doc.addFont(fontFileName, fontFamily, 'bold');
    doc.setFont(fontFamily, 'normal');
    return fontFamily;
  } catch {
    doc.setFont('helvetica', 'normal');
    return 'helvetica';
  }
};

const getPendingSales = (uid) => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getPendingSalesStorageKey(uid));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const setPendingSales = (uid, sales) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(getPendingSalesStorageKey(uid), JSON.stringify(sales));
};

const getSaleTime = (sale) => {
  if (typeof sale.createdAtMs === 'number') {
    return sale.createdAtMs;
  }

  if (sale.createdAt?.seconds) {
    return sale.createdAt.seconds * 1000;
  }

  return 0;
};

function App() {
  const [products, setProducts] = useState([createProduct()]);
  const [sales, setSales] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authEmail, setAuthEmail] = useState('akanrooluwaseun180@gmail.com');
  const [authPassword, setAuthPassword] = useState('');
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [isGoogleSigningIn, setIsGoogleSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [selectedInsightKey, setSelectedInsightKey] = useState('today');
  const [isExportingInsight, setIsExportingInsight] = useState(false);
  const [downloadingSaleId, setDownloadingSaleId] = useState('');

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      setAuthError('Firebase Authentication is not configured.');
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
      setAuthError('');
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!db) {
      setErrorMessage('Firebase is not configured. Add values to your .env file.');
      return undefined;
    }

    if (!currentUser) {
      setSales([]);
      return undefined;
    }

    const salesQuery = query(collection(db, 'sales'), where('createdByUid', '==', currentUser.uid));
    const unsubscribe = onSnapshot(
      salesQuery,
      (snapshot) => {
        const nextSales = snapshot.docs
          .map((doc) => ({
            id: doc.id,
            ...doc.data()
          }))
          .sort((a, b) => getSaleTime(b) - getSaleTime(a));

        setSales(nextSales);
      },
      () => {
        setErrorMessage('Could not load sales from Firebase.');
      }
    );

    return () => unsubscribe();
  }, [currentUser]);

  const saveSaleToFirebase = useCallback(async (salePayload) => {
    if (!db) {
      throw new Error('Firebase is not configured.');
    }

    return withTimeout(
      addDoc(collection(db, 'sales'), {
        ...salePayload,
        createdAt: serverTimestamp()
      }),
      FIREBASE_SAVE_TIMEOUT_MS
    );
  }, []);

  const queuePendingSale = useCallback((salePayload) => {
    if (!currentUser?.uid) {
      return;
    }

    const current = getPendingSales(currentUser.uid);
    const next = [...current, salePayload];
    setPendingSales(currentUser.uid, next);
    setPendingSyncCount(next.length);
  }, [currentUser]);

  const flushPendingSales = useCallback(async () => {
    if (!db || !currentUser?.uid || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      return;
    }

    const pending = getPendingSales(currentUser.uid);
    if (!pending.length) {
      setPendingSyncCount(0);
      return;
    }

    const unsynced = [];

    for (const salePayload of pending) {
      try {
        await saveSaleToFirebase(salePayload);
      } catch {
        unsynced.push(salePayload);
      }
    }

    setPendingSales(currentUser.uid, unsynced);
    setPendingSyncCount(unsynced.length);

    if (!unsynced.length) {
      setStatusMessage((current) => current || 'All pending receipts synced to Firebase.');
    }
  }, [currentUser, saveSaleToFirebase]);

  useEffect(() => {
    if (!currentUser?.uid) {
      setPendingSyncCount(0);
      return undefined;
    }

    setPendingSyncCount(getPendingSales(currentUser.uid).length);

    const runSync = () => {
      void flushPendingSales();
    };

    runSync();

    if (typeof window !== 'undefined') {
      window.addEventListener('online', runSync);
    }

    const intervalId = setInterval(runSync, 30000);

    return () => {
      clearInterval(intervalId);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', runSync);
      }
    };
  }, [currentUser, flushPendingSales]);

  const liveTotal = useMemo(
    () =>
      products.reduce((sum, product) => {
        const lineTotal = safeNumber(product.amount) * safeNumber(product.qty);
        return sum + lineTotal;
      }, 0),
    [products]
  );

  const salesMetrics = useMemo(() => {
    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = startOfCurrentMonth;

    const startOfLastThreeMonths = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const endOfLastThreeMonths = startOfCurrentMonth;

    const buildPeriod = (start, end) => {
      const filtered = sales.filter((sale) => {
        const timestamp = getSaleTime(sale);
        const afterStart = timestamp >= start.getTime();
        const beforeEnd = end ? timestamp < end.getTime() : true;
        return afterStart && beforeEnd;
      });

      const receipts = [...filtered].sort((a, b) => getSaleTime(b) - getSaleTime(a));
      const productTotals = new Map();

      receipts.forEach((sale) => {
        const saleItems = Array.isArray(sale.items) ? sale.items : [];

        saleItems.forEach((item) => {
          const itemName = String(item?.name ?? '').trim() || 'Unnamed product';
          const qty = Math.max(0, safeNumber(item?.qty));
          const amount = safeNumber(item?.amount);
          const lineTotal = qty * amount;

          const current = productTotals.get(itemName) || { name: itemName, qty: 0, total: 0 };
          current.qty += qty;
          current.total += lineTotal;
          productTotals.set(itemName, current);
        });
      });

      return {
        total: receipts.reduce((sum, sale) => sum + safeNumber(sale.total), 0),
        count: receipts.length,
        receipts,
        products: Array.from(productTotals.values()).sort((a, b) => b.total - a.total)
      };
    };

    return {
      today: buildPeriod(startOfToday),
      week: buildPeriod(startOfWeek),
      month: buildPeriod(startOfMonth),
      lastMonth: buildPeriod(startOfLastMonth, endOfLastMonth),
      lastThreeMonths: buildPeriod(startOfLastThreeMonths, endOfLastThreeMonths)
    };
  }, [sales]);

  const updateProduct = (id, field, value) => {
    setProducts((current) =>
      current.map((product) => (product.id === id ? { ...product, [field]: value } : product))
    );
  };

  const addNewProduct = () => {
    setProducts((current) => [...current, createProduct()]);
  };

  const removeProduct = (id) => {
    setProducts((current) => {
      if (current.length === 1) {
        return current;
      }

      return current.filter((product) => product.id !== id);
    });
  };

  const downloadPdf = async ({ receiptNumber, createdAt, items, total }) => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const pdfFontFamily = await applyPdfUnicodeFont(doc);

    const colors = {
      primary: [0, 87, 184],
      text: [17, 43, 74],
      softText: [72, 106, 144],
      panel: [232, 243, 255],
      rowBorder: [201, 222, 248]
    };

    const tableRows = items.map((item, index) => [
      `${index + 1}`,
      item.name,
      `${item.qty}`,
      formatCurrency(item.amount),
      formatCurrency(item.amount * item.qty)
    ]);

    const subtotal = items.reduce((sum, item) => sum + item.amount * item.qty, 0);
    const tableMarginX = 12;
    const tableWidth = pageWidth - tableMarginX * 2;
    const numberColWidth = 10;
    const qtyColWidth = 16;
    const amountColWidth = 36;
    const lineTotalColWidth = 40;
    const productColWidth = tableWidth - (numberColWidth + qtyColWidth + amountColWidth + lineTotalColWidth);

    doc.setFillColor(...colors.panel);
    doc.roundedRect(10, 10, pageWidth - 20, 48, 3, 3, 'F');

    doc.setTextColor(...colors.text);
    doc.setFont(pdfFontFamily, 'bold');
    doc.setFontSize(17);
    doc.text(COMPANY_NAME, 16, 22);

    doc.setFont(pdfFontFamily, 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...colors.softText);
    doc.text('Leather Bags & Accessories', 16, 29);
    doc.text('Official Sales Receipt', 16, 35);
    doc.text(`Phone/WhatsApp: ${COMPANY_PHONE}`, 16, 41);
    doc.text(`Address: ${COMPANY_ADDRESS}`, 16, 47);

    doc.setTextColor(...colors.primary);
    doc.setFont(pdfFontFamily, 'bold');
    doc.setFontSize(13);
    doc.text('RECEIPT', pageWidth - 16, 22, { align: 'right' });

    doc.setFont(pdfFontFamily, 'normal');
    doc.setFontSize(10);
    doc.text(`No: ${receiptNumber}`, pageWidth - 16, 30, { align: 'right' });
    doc.text(`Date: ${createdAt.toLocaleString()}`, pageWidth - 16, 36, { align: 'right' });

    autoTable(doc, {
      startY: 66,
      head: [['#', 'Product', 'Qty', 'Amount', 'Line Total']],
      body: tableRows,
      foot: [
        [{ content: 'Subtotal', colSpan: 4, styles: { halign: 'right' } }, formatCurrency(subtotal)],
        [{ content: 'Total', colSpan: 4, styles: { halign: 'right', fontStyle: 'bold' } }, formatCurrency(total)]
      ],
      showFoot: 'lastPage',
      theme: 'grid',
      tableWidth,
      margin: { left: tableMarginX, right: tableMarginX },
      styles: {
        font: pdfFontFamily,
        fontSize: 9.5,
        cellPadding: 2.5,
        overflow: 'linebreak',
        valign: 'middle',
        textColor: colors.text
      },
      columnStyles: {
        0: { cellWidth: numberColWidth, halign: 'center' },
        1: { cellWidth: productColWidth, overflow: 'linebreak' },
        2: { cellWidth: qtyColWidth, halign: 'center' },
        3: { cellWidth: amountColWidth, halign: 'right' },
        4: { cellWidth: lineTotalColWidth, halign: 'right' }
      },
      headStyles: {
        fillColor: colors.primary,
        textColor: [255, 255, 255],
        lineColor: colors.primary,
        lineWidth: 0.1
      },
      bodyStyles: {
        lineColor: colors.rowBorder,
        lineWidth: 0.1
      },
      alternateRowStyles: {
        fillColor: [246, 250, 255]
      },
      footStyles: {
        fillColor: colors.panel,
        textColor: colors.text,
        lineColor: colors.rowBorder,
        lineWidth: 0.1
      },
      didParseCell: (data) => {
        if (data.section === 'body' && (data.column.index === 3 || data.column.index === 4)) {
          const rawText = String(data.cell.raw ?? '');
          if (rawText.length > 15) {
            data.cell.styles.fontSize = 8.5;
          }
        }
      }
    });

    const tableEnd = doc.lastAutoTable?.finalY ?? 70;
    const footerBlockHeight = 24;
    let footerStartY = tableEnd + 8;

    if (footerStartY + footerBlockHeight > pageHeight - 12) {
      doc.addPage();
      footerStartY = 20;
    }

    doc.setDrawColor(...colors.rowBorder);
    doc.line(tableMarginX, footerStartY, pageWidth - tableMarginX, footerStartY);

    doc.setFont(pdfFontFamily, 'normal');
    doc.setTextColor(...colors.softText);
    doc.setFontSize(10);
    doc.text(`Thank you for choosing ${COMPANY_NAME}.`, tableMarginX, footerStartY + 8);
    doc.text('Please keep this receipt for your records.', tableMarginX, footerStartY + 14);
    doc.text('Bags purchased in good condition are neither returnable nor refundable.', tableMarginX, footerStartY + 20);

    doc.save(`${COMPANY_FILE_PREFIX}-${receiptNumber}.pdf`);
  };

  const downloadInsightPdf = async ({ insightLabel, insight, insightKey }) => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const tableMarginX = 12;
    const tableWidth = pageWidth - tableMarginX * 2;
    const pdfFontFamily = await applyPdfUnicodeFont(doc);

    const colors = {
      primary: [0, 87, 184],
      text: [17, 43, 74],
      softText: [72, 106, 144],
      panel: [232, 243, 255],
      rowBorder: [201, 222, 248]
    };

    const receipts = Array.isArray(insight?.receipts) ? insight.receipts : [];
    const products = Array.isArray(insight?.products) ? insight.products : [];
    const totalUnits = receipts.reduce((sum, sale) => {
      const saleItems = Array.isArray(sale.items) ? sale.items : [];
      return sum + saleItems.reduce((itemSum, item) => itemSum + Math.max(0, safeNumber(item?.qty)), 0);
    }, 0);

    const generatedAt = new Date();
    const receiptRows =
      receipts.length > 0
        ? receipts.map((sale) => {
            const saleItems = Array.isArray(sale.items) ? sale.items : [];
            const units = saleItems.reduce((sum, item) => sum + Math.max(0, safeNumber(item?.qty)), 0);
            return [
              sale.receiptNumber || sale.id || String(getSaleTime(sale)),
              new Date(getSaleTime(sale)).toLocaleString(),
              `${saleItems.length} line(s), ${units} unit(s)`,
              formatCurrency(safeNumber(sale.total))
            ];
          })
        : [['No receipts for this period', '-', '-', formatCurrency(0)]];

    const productRows =
      products.length > 0
        ? products.map((item) => [item.name, `${safeNumber(item.qty)}`, formatCurrency(safeNumber(item.total))])
        : [['No products for this period', '-', formatCurrency(0)]];

    doc.setFillColor(...colors.panel);
    doc.roundedRect(10, 10, pageWidth - 20, 42, 3, 3, 'F');

    doc.setFont(pdfFontFamily, 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...colors.text);
    doc.text(COMPANY_NAME, 16, 22);

    doc.setFont(pdfFontFamily, 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...colors.softText);
    doc.text(`Sales Insight Report: ${insightLabel}`, 16, 29);
    doc.text(`Generated: ${generatedAt.toLocaleString()}`, 16, 35);
    doc.text(`Phone/WhatsApp: ${COMPANY_PHONE}`, 16, 41);

    doc.setFont(pdfFontFamily, 'bold');
    doc.setTextColor(...colors.primary);
    doc.setFontSize(11);
    doc.text(`Receipts: ${receipts.length}`, pageWidth - 16, 23, { align: 'right' });
    doc.text(`Total Sales: ${formatCurrency(insight?.total)}`, pageWidth - 16, 30, { align: 'right' });
    doc.text(`Units Sold: ${totalUnits}`, pageWidth - 16, 37, { align: 'right' });

    autoTable(doc, {
      startY: 58,
      head: [['Receipt No', 'Date', 'Items / Units', 'Total']],
      body: receiptRows,
      theme: 'grid',
      tableWidth,
      margin: { left: tableMarginX, right: tableMarginX },
      styles: {
        font: pdfFontFamily,
        fontSize: 9,
        cellPadding: 2.4,
        overflow: 'linebreak',
        textColor: colors.text
      },
      columnStyles: {
        0: { cellWidth: 42 },
        1: { cellWidth: 43 },
        2: { cellWidth: 52, overflow: 'linebreak' },
        3: { cellWidth: 33, halign: 'right' }
      },
      headStyles: {
        fillColor: colors.primary,
        textColor: [255, 255, 255],
        lineColor: colors.primary,
        lineWidth: 0.1
      },
      bodyStyles: {
        lineColor: colors.rowBorder,
        lineWidth: 0.1
      },
      alternateRowStyles: {
        fillColor: [246, 250, 255]
      }
    });

    let productStartY = (doc.lastAutoTable?.finalY ?? 70) + 10;
    if (productStartY > pageHeight - 48) {
      doc.addPage();
      productStartY = 20;
    }

    doc.setFont(pdfFontFamily, 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...colors.primary);
    doc.text('Product Totals', tableMarginX, productStartY);

    autoTable(doc, {
      startY: productStartY + 4,
      head: [['Product', 'Qty', 'Total']],
      body: productRows,
      foot: [[{ content: 'Grand Total', styles: { halign: 'right', fontStyle: 'bold' }, colSpan: 2 }, formatCurrency(insight?.total)]],
      showFoot: 'lastPage',
      theme: 'grid',
      tableWidth,
      margin: { left: tableMarginX, right: tableMarginX },
      styles: {
        font: pdfFontFamily,
        fontSize: 9,
        cellPadding: 2.4,
        overflow: 'linebreak',
        textColor: colors.text
      },
      columnStyles: {
        0: { cellWidth: 118, overflow: 'linebreak' },
        1: { cellWidth: 20, halign: 'center' },
        2: { cellWidth: 32, halign: 'right' }
      },
      headStyles: {
        fillColor: colors.primary,
        textColor: [255, 255, 255],
        lineColor: colors.primary,
        lineWidth: 0.1
      },
      bodyStyles: {
        lineColor: colors.rowBorder,
        lineWidth: 0.1
      },
      footStyles: {
        fillColor: colors.panel,
        textColor: colors.text,
        lineColor: colors.rowBorder,
        lineWidth: 0.1
      },
      alternateRowStyles: {
        fillColor: [246, 250, 255]
      }
    });

    const dateStamp = `${generatedAt.getFullYear()}${String(generatedAt.getMonth() + 1).padStart(2, '0')}${String(
      generatedAt.getDate()
    ).padStart(2, '0')}`;
    const periodSlug = toFileSlug(insightLabel || insightKey || 'insight');
    doc.save(`${COMPANY_FILE_PREFIX}-${periodSlug}-insight-${dateStamp}.pdf`);
  };

  const handleDownloadSalePdf = async (sale) => {
    setErrorMessage('');
    setStatusMessage('');

    const saleItems = Array.isArray(sale?.items)
      ? sale.items
          .map((item) => ({
            name: String(item?.name ?? '').trim(),
            amount: safeNumber(item?.amount),
            qty: Math.max(1, Math.floor(safeNumber(item?.qty)))
          }))
          .filter((item) => item.name && item.amount > 0 && item.qty > 0)
      : [];

    if (!saleItems.length) {
      setErrorMessage('This sale has no valid item rows to regenerate a receipt PDF.');
      return;
    }

    const fallbackTimestamp = Date.now();
    const saleTimestamp = getSaleTime(sale) || fallbackTimestamp;
    const receiptNumber = sale?.receiptNumber || `SFP-${saleTimestamp}`;
    const computedTotal = saleItems.reduce((sum, item) => sum + item.amount * item.qty, 0);
    const total = safeNumber(sale?.total) > 0 ? safeNumber(sale.total) : computedTotal;
    const saleId = sale?.id || receiptNumber;

    try {
      setDownloadingSaleId(String(saleId));
      await downloadPdf({
        receiptNumber,
        createdAt: new Date(saleTimestamp),
        items: saleItems,
        total
      });
      setStatusMessage(`Receipt ${receiptNumber} downloaded.`);
    } catch {
      setErrorMessage('Unable to regenerate this receipt PDF. Please try again.');
    } finally {
      setDownloadingSaleId('');
    }
  };

  const handleGenerateReceipt = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    if (!currentUser) {
      setErrorMessage('Please sign in before generating receipts.');
      return;
    }

    const cleanItems = products
      .map((product) => ({
        name: product.name.trim(),
        amount: safeNumber(product.amount),
        qty: Math.max(1, Math.floor(safeNumber(product.qty)))
      }))
      .filter((item) => item.name && item.amount > 0 && item.qty > 0);

    if (!cleanItems.length) {
      setErrorMessage('Add at least one product with name, amount and quantity.');
      return;
    }

    const total = cleanItems.reduce((sum, item) => sum + item.amount * item.qty, 0);
    const createdAtMs = Date.now();
    const receiptNumber = `SFP-${createdAtMs}`;
    const salePayload = {
      companyName: COMPANY_NAME,
      receiptNumber,
      items: cleanItems,
      total,
      createdAtMs,
      createdByUid: currentUser.uid,
      createdByEmail: currentUser.email || ''
    };

    try {
      setIsSaving(true);

      await downloadPdf({
        receiptNumber,
        createdAt: new Date(createdAtMs),
        items: cleanItems,
        total
      });

      if (!db) {
        queuePendingSale(salePayload);
        setStatusMessage('Receipt downloaded. Cloud sync is currently unavailable, so this receipt is queued and will sync automatically.');
      } else {
        try {
          await saveSaleToFirebase(salePayload);
          setStatusMessage('Receipt downloaded and synced to Firebase.');
        } catch {
          queuePendingSale(salePayload);
          setStatusMessage('Receipt downloaded successfully. Sync is delayed and will retry automatically in the background.');
        }
      }

      setProducts([createProduct()]);
    } catch {
      setErrorMessage('Unable to generate PDF. Please allow downloads in your browser and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const metricCards = [
    { key: 'today', label: 'Today', value: salesMetrics.today },
    { key: 'week', label: 'This Week', value: salesMetrics.week },
    { key: 'month', label: 'This Month', value: salesMetrics.month },
    { key: 'lastMonth', label: 'Last Month', value: salesMetrics.lastMonth },
    { key: 'lastThreeMonths', label: 'Last 3 Months', value: salesMetrics.lastThreeMonths }
  ];
  const selectedInsight = salesMetrics[selectedInsightKey] || salesMetrics.today;
  const selectedInsightLabel =
    metricCards.find((metric) => metric.key === selectedInsightKey)?.label || 'Today';

  const handleDownloadInsightPdf = async () => {
    setErrorMessage('');
    setStatusMessage('');

    if (!selectedInsight?.count) {
      setStatusMessage(`No receipts in ${selectedInsightLabel} to export.`);
      return;
    }

    try {
      setIsExportingInsight(true);
      await downloadInsightPdf({
        insightLabel: selectedInsightLabel,
        insight: selectedInsight,
        insightKey: selectedInsightKey
      });
      setStatusMessage(`${selectedInsightLabel} insight PDF downloaded.`);
    } catch {
      setErrorMessage('Unable to generate insight PDF. Please allow downloads in your browser and try again.');
    } finally {
      setIsExportingInsight(false);
    }
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthError('');
    setStatusMessage('');
    setErrorMessage('');

    const email = authEmail.trim();
    const password = authPassword;

    if (!email || !password) {
      setAuthError('Email and password are required.');
      return;
    }

    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }

    if (!auth) {
      setAuthError('Firebase Authentication is not configured.');
      return;
    }

    try {
      setIsAuthSubmitting(true);
      if (authMode === 'register') {
        await createUserWithEmailAndPassword(auth, email, password);
        setStatusMessage('Account created successfully.');
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        setStatusMessage('Signed in successfully.');
      }

      setAuthPassword('');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const details = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';

      if (code.includes('auth/email-already-in-use')) {
        setAuthError('This email is already in use. Sign in instead.');
      } else if (code.includes('auth/operation-not-allowed')) {
        setAuthError('Email/Password sign-in is disabled in Firebase. Enable it in Authentication -> Sign-in method.');
      } else if (code.includes('auth/invalid-credential') || code.includes('auth/wrong-password')) {
        setAuthError('Invalid email or password.');
      } else if (code.includes('auth/user-not-found')) {
        setAuthError('No account found with this email.');
      } else if (code.includes('auth/invalid-email')) {
        setAuthError('The email address format is invalid.');
      } else if (code.includes('auth/too-many-requests')) {
        setAuthError('Too many attempts. Please wait a moment and try again.');
      } else if (code.includes('auth/weak-password')) {
        setAuthError('Password is too weak. Use at least 6 characters.');
      } else if (code.includes('auth/network-request-failed')) {
        setAuthError('Network issue detected. Check your internet and try again.');
      } else {
        setAuthError(
          `Authentication failed (${code || 'unknown-error'}). ${details || 'Please try again.'}`
        );
      }
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError('');
    setStatusMessage('');
    setErrorMessage('');

    if (!auth) {
      setAuthError('Firebase Authentication is not configured.');
      return;
    }

    try {
      setIsGoogleSigningIn(true);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
      setStatusMessage('Signed in with Google.');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const details = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';

      if (code.includes('auth/popup-closed-by-user')) {
        setAuthError('Google sign-in was canceled.');
      } else if (code.includes('auth/operation-not-allowed')) {
        setAuthError('Google sign-in is disabled in Firebase. Enable Google in Authentication -> Sign-in method.');
      } else if (code.includes('auth/popup-blocked')) {
        setAuthError('Popup was blocked. Allow popups and try Google sign-in again.');
      } else if (code.includes('auth/unauthorized-domain')) {
        setAuthError('Current domain is not authorized for Google sign-in. Add it in Firebase Authentication settings.');
      } else if (code.includes('auth/network-request-failed')) {
        setAuthError('Network issue detected. Check your internet and try again.');
      } else {
        setAuthError(`Google sign-in failed (${code || 'unknown-error'}). ${details || 'Please try again.'}`);
      }
    } finally {
      setIsGoogleSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    setAuthError('');
    setStatusMessage('');
    setErrorMessage('');

    if (!auth) {
      return;
    }

    try {
      await signOut(auth);
      setSales([]);
      setProducts([createProduct()]);
      setStatusMessage('Signed out successfully.');
    } catch {
      setErrorMessage('Unable to sign out at the moment. Please try again.');
    }
  };

  if (!authReady) {
    return (
      <main className="app-shell">
        <section className="hero reveal">
          <p className="eyebrow">Secure Access</p>
          <h1>{COMPANY_NAME}</h1>
          <p className="subtitle">Checking authentication status...</p>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="app-shell">
        <section className="hero reveal auth-shell">
          <p className="eyebrow">Secure Access</p>
          <h1>{COMPANY_NAME}</h1>
          <p className="subtitle">Sign in to create receipts, download sales reports, and sync data to Firebase.</p>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <label>
              Email
              <input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="Minimum 6 characters"
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
              />
            </label>

            <button type="submit" className="primary-button" disabled={isAuthSubmitting || isGoogleSigningIn}>
              {isAuthSubmitting ? 'Please wait...' : authMode === 'register' ? 'Create Account' : 'Sign In'}
            </button>

            <button
              type="button"
              className="secondary-button auth-google"
              onClick={handleGoogleSignIn}
              disabled={isGoogleSigningIn || isAuthSubmitting}
            >
              {isGoogleSigningIn ? 'Connecting to Google...' : 'Continue with Google'}
            </button>
          </form>

          <div className="auth-switch">
            <span>{authMode === 'register' ? 'Already have an account?' : "Don't have an account?"}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setAuthMode((current) => (current === 'register' ? 'login' : 'register'));
                setAuthError('');
              }}
            >
              {authMode === 'register' ? 'Switch to Sign In' : 'Create Account'}
            </button>
          </div>

          {authError ? <p className="status error">{authError}</p> : null}
          {statusMessage ? <p className="status ok">{statusMessage}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero reveal">
        <p className="eyebrow">Invoice + Receipt Engine</p>
        <h1>{COMPANY_NAME}</h1>
        <p className="subtitle">Leather bags sales receipts with instant PDF downloads and live sales tracking.</p>
        <div className="session-bar">
          <small>Signed in as: {currentUser.email || currentUser.uid}</small>
          <button type="button" className="ghost-button" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="panel reveal invoice-panel">
          <div className="panel-head">
            <h2>Create Receipt</h2>
            <p>Enter product name, amount, and quantity for each item sold.</p>
          </div>

          <form className="invoice-form" onSubmit={handleGenerateReceipt}>
            <div className="product-list">
              {products.map((product, index) => (
                <div className="product-row" key={product.id}>
                  <label>
                    Product Name
                    <input
                      type="text"
                      placeholder="e.g. Classic Tote Bag"
                      value={product.name}
                      onChange={(event) => updateProduct(product.id, 'name', event.target.value)}
                    />
                  </label>

                  <label>
                    Amount
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={product.amount}
                      onChange={(event) => updateProduct(product.id, 'amount', event.target.value)}
                    />
                  </label>

                  <label>
                    Qty
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={product.qty}
                      onChange={(event) => updateProduct(product.id, 'qty', event.target.value)}
                    />
                  </label>

                  <button
                    type="button"
                    className="ghost-button"
                    disabled={products.length === 1}
                    onClick={() => removeProduct(product.id)}
                    aria-label={`Remove product ${index + 1}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="actions">
              <button type="button" className="secondary-button" onClick={addNewProduct}>
                Add Another Product
              </button>

              <div className="total-card">
                <span>Total</span>
                <strong>{formatCurrency(liveTotal)}</strong>
              </div>
            </div>

            <button type="submit" className="primary-button" disabled={isSaving}>
              {isSaving ? 'Generating...' : 'Generate Receipt + Download PDF'}
            </button>
          </form>

          {statusMessage ? <p className="status ok">{statusMessage}</p> : null}
          {errorMessage ? <p className="status error">{errorMessage}</p> : null}
          {pendingSyncCount > 0 ? (
            <p className="status warn">{pendingSyncCount} receipt(s) pending Firebase sync.</p>
          ) : null}
        </article>

        <article className="panel reveal">
          <div className="panel-head">
            <h2>Sales Insights</h2>
            <p>Live totals from your saved receipts in Firebase Firestore.</p>
          </div>

          <div className="metrics">
            {metricCards.map((metric) => (
              <button
                type="button"
                className={`metric-card ${selectedInsightKey === metric.key ? 'active' : ''}`}
                key={metric.label}
                onClick={() => setSelectedInsightKey(metric.key)}
                aria-pressed={selectedInsightKey === metric.key}
              >
                <p>{metric.label}</p>
                <h3>{formatCurrency(metric.value.total)}</h3>
                <small>{metric.value.count} receipt(s)</small>
              </button>
            ))}
          </div>

          <section className="breakdown-shell">
            <div className="breakdown-head">
              <div>
                <h3>{selectedInsightLabel} Breakdown</h3>
                <p>Click any insight card above to change this breakdown.</p>
              </div>
              <button
                type="button"
                className="secondary-button breakdown-download"
                onClick={handleDownloadInsightPdf}
                disabled={isExportingInsight || !selectedInsight?.count}
              >
                {isExportingInsight ? 'Preparing PDF...' : `Download ${selectedInsightLabel} PDF`}
              </button>
            </div>

            <div className="breakdown-grid">
              <div className="breakdown-block">
                <h4>Receipts</h4>
                <div className="breakdown-list">
                  {!selectedInsight.receipts.length ? (
                    <p className="empty">No receipts for this period.</p>
                  ) : (
                    selectedInsight.receipts.map((sale) => {
                      const saleItems = Array.isArray(sale.items) ? sale.items : [];
                      const units = saleItems.reduce((sum, item) => sum + Math.max(0, safeNumber(item?.qty)), 0);
                      const lines = saleItems.length;
                      const key = sale.id || sale.receiptNumber || String(getSaleTime(sale));
                      const canDownload = saleItems.length > 0;

                      return (
                        <div className="breakdown-item" key={key}>
                          <div>
                            <strong>{sale.receiptNumber || key}</strong>
                            <p>{new Date(getSaleTime(sale)).toLocaleString()}</p>
                            <small>
                              {lines} line item(s), {units} unit(s)
                            </small>
                          </div>
                          <div className="item-actions">
                            <span>{formatCurrency(sale.total)}</span>
                            <button
                              type="button"
                              className="ghost-button mini-download"
                              onClick={() => handleDownloadSalePdf(sale)}
                              disabled={!canDownload || downloadingSaleId === String(key)}
                            >
                              {downloadingSaleId === String(key) ? 'Preparing...' : 'Download PDF'}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="breakdown-block">
                <h4>Product Totals</h4>
                <div className="breakdown-list">
                  {!selectedInsight.products.length ? (
                    <p className="empty">No product totals for this period.</p>
                  ) : (
                    selectedInsight.products.map((item) => (
                      <div className="breakdown-item" key={item.name}>
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.qty} unit(s) sold</p>
                        </div>
                        <span>{formatCurrency(item.total)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>

          <h3 className="recent-heading">Recent Receipts</h3>
          <div className="recent-list">
            {!sales.length ? (
              <p className="empty">No receipts yet.</p>
            ) : (
              sales.slice(0, 8).map((sale) => {
                const saleKey = sale.id || sale.receiptNumber || String(getSaleTime(sale));
                const canDownload = Array.isArray(sale.items) && sale.items.length > 0;

                return (
                  <div className="recent-item" key={saleKey}>
                    <div>
                      <strong>{sale.receiptNumber || saleKey}</strong>
                      <p>{new Date(getSaleTime(sale)).toLocaleString()}</p>
                    </div>
                    <div className="item-actions">
                      <span>{formatCurrency(sale.total)}</span>
                      <button
                        type="button"
                        className="ghost-button mini-download"
                        onClick={() => handleDownloadSalePdf(sale)}
                        disabled={!canDownload || downloadingSaleId === String(saleKey)}
                      >
                        {downloadingSaleId === String(saleKey) ? 'Preparing...' : 'Download PDF'}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </article>
      </section>
    </main>
  );
}

export default App;
