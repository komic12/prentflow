const documentId = new URLSearchParams(window.location.search).get('documentId');
const pageGrid = document.getElementById('page-grid');
const searchInput = document.getElementById('search-input');
const selectionSummary = document.getElementById('selection-summary');
const docNameEl = document.getElementById('document-name');
const docPagesEl = document.getElementById('doc-pages');
const docStatusEl = document.getElementById('doc-status');
const visibleCountEl = document.getElementById('visible-count');
const extractBtn = document.getElementById('extract-pages-btn');
const submitBtn = document.getElementById('submit-pages-btn');
const selectAllBtn = document.getElementById('select-all-btn');
const clearSelectionBtn = document.getElementById('clear-selection-btn');
const prevBtn = document.getElementById('prev-page-btn');
const nextBtn = document.getElementById('next-page-btn');
const documentFrame = document.getElementById('document-frame');

let documentMeta = null;
let pages = [];
let filteredPages = [];
let selectedPageIds = new Set();
let activePageNumber = 1;

function updateSelectionSummary() {
    const total = selectedPageIds.size;
    if (!total) {
        selectionSummary.textContent = 'No pages selected.';
        return;
    }
    selectionSummary.textContent = `${total} page${total === 1 ? '' : 's'} selected.`;
}

function buildPageGrid() {
    pageGrid.innerHTML = filteredPages.map(page => {
        const selected = selectedPageIds.has(page.pageId);
        return `<button type="button" data-page-id="${page.pageId}" data-page-number="${page.pageNumber}" class="relative rounded-3xl border ${selected ? 'border-blue-600 bg-blue-50' : 'border-slate-200 bg-white'} p-2 text-left shadow-sm transition hover:border-blue-400">
        <img src="${page.thumbnailUrl}" alt="Page ${page.pageNumber}" class="h-32 w-full rounded-2xl object-cover" />
        <div class="mt-2 flex items-center justify-between gap-2 text-xs text-slate-600">
          <span>Page ${page.pageNumber}</span>
          <span class="${selected ? 'text-blue-700' : 'text-slate-400'}">${selected ? 'Selected' : 'Tap'}</span>
        </div>
        <div class="absolute left-3 top-3 h-6 w-6 rounded-full ${selected ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-500'} flex items-center justify-center text-[11px] font-semibold">${page.pageNumber}</div>
      </button>`;
    }).join('');

    pageGrid.querySelectorAll('button[data-page-id]').forEach(button => {
        button.addEventListener('click', () => {
            const pageId = button.dataset.pageId;
            const pageNumber = Number(button.dataset.pageNumber);
            if (selectedPageIds.has(pageId)) {
                selectedPageIds.delete(pageId);
            } else {
                selectedPageIds.add(pageId);
            }
            activePageNumber = pageNumber;
            renderViewer();
            updateSelectionSummary();
            buildPageGrid();
        });
    });

    visibleCountEl.textContent = `${filteredPages.length} shown`;
}

function filterPages() {
    const query = searchInput.value.trim().toLowerCase();
    filteredPages = pages.filter(page => {
        if (!query) return true;
        return page.extractedText.toLowerCase().includes(query);
    });
}

function renderViewer() {
    const selectedPage = pages.find(page => page.pageNumber === activePageNumber);
    if (!selectedPage) return;
    documentFrame.src = `${window.PRINTFLOW_API_URL || window.location.origin}/api/documents/${documentMeta.id}/download`;
}

async function loadDocument() {
    if (!documentId) {
        alert('Document ID is required in the URL.');
        return;
    }
    try {
        const res = await API.get(`/api/documents/${documentId}`);
        documentMeta = res.document;
        pages = res.pages;
        filteredPages = [...pages];

        docNameEl.textContent = documentMeta.fileName || 'Untitled document';
        docPagesEl.textContent = documentMeta.totalPages || pages.length;
        docStatusEl.textContent = documentMeta.status || 'uploaded';
        activePageNumber = pages[0] ? (pages[0].pageNumber || 1) : 1;

        buildPageGrid();
        updateSelectionSummary();
        renderViewer();
    } catch (err) {
        console.error(err);
        alert('Could not load document. Please try again.');
    }
}

searchInput.addEventListener('input', () => {
    filterPages();
    buildPageGrid();
});

selectAllBtn.addEventListener('click', () => {
    pages.forEach(page => selectedPageIds.add(page.pageId));
    updateSelectionSummary();
    buildPageGrid();
});

clearSelectionBtn.addEventListener('click', () => {
    selectedPageIds.clear();
    updateSelectionSummary();
    buildPageGrid();
});

prevBtn.addEventListener('click', () => {
    if (activePageNumber <= 1) return;
    activePageNumber -= 1;
    renderViewer();
});

nextBtn.addEventListener('click', () => {
    if (activePageNumber >= pages.length) return;
    activePageNumber += 1;
    renderViewer();
});

extractBtn.addEventListener('click', async() => {
    const pageNumbers = pages.filter(page => selectedPageIds.has(page.pageId)).map(page => page.pageNumber);
    if (!pageNumbers.length) return alert('Select at least one page before extracting.');
    try {
        const body = { selectedPages: pageNumbers };
        const response = await fetch(`${window.PRINTFLOW_API_URL || window.location.origin}/api/documents/${documentId}/extract?download=1`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error('Extraction failed');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    } catch (err) {
        console.error(err);
        alert('Could not extract pages.');
    }
});

submitBtn.addEventListener('click', async() => {
    const pageNumbers = pages.filter(page => selectedPageIds.has(page.pageId)).map(page => page.pageNumber);
    if (!pageNumbers.length) return alert('Select at least one page before submitting.');
    try {
        const response = await API.post(`/api/documents/${documentId}/submit`, { selectedPages: pageNumbers });
        if (response.submission) {
            alert('Submitted successfully. The extracted PDF is available to the owner.');
            return;
        }
        throw new Error('Submission failed');
    } catch (err) {
        console.error(err);
        alert('Could not submit selected pages.');
    }
});

window.addEventListener('load', loadDocument);