# PrintFlow Website + Windows Print Agent

The website backend now exposes an authenticated agent API under `/api/print-agent`. The Windows agent signs in with a cyber owner's existing website email and password, receives only that owner's paid jobs, discovers installed USB/Wi-Fi Windows printers, applies the owner's printer settings, reports progress events, and prints a customer receipt at the end of each job.

## Deployment

Run the website backend as before from `backend` with `npm start`. Set `PRINTFLOW_API_URL` in the Windows laptop environment to the public website URL. Copy `print-agent-app` to each Windows laptop, install Node.js 18 or newer, and run `Start-PrintFlow-Agent.cmd`. The agent opens a local operator page at `http://127.0.0.1:17321`; sign in there with the cyber owner account. In the owner dashboard, use **Connect Print Agent** to verify the connection.

The agent keeps its bearer token in `agent-data.json`, binds only to localhost, and sends heartbeat state to the website. The owner dashboard upgrade contact wording has been removed as requested. Existing customer ordering and dashboard sections were otherwise left intact.

## Printing behavior

A colour job is routed to the configured colour printer and a black-and-white job to the configured black-and-white printer. If a printer reports duplex capability, the job is sent as an automatic duplex job and the website receives a completed duplex event. If a printer is single-sided, the agent reports that odd pages are done and waits for the operator to turn/reload the paper before continuing from the local agent page. The receipt is printed after the document workflow.

The current implementation is designed for PDFs and files handled by the installed Windows print association. For production use, validate each printer driver and install a PDF print handler on the laptop. The backend smoke test exposed an existing `pdf-parse`/Node runtime compatibility issue during eager module loading; the route was changed to lazy-load the parser so the website can start, while document parsing still depends on the installed parser runtime.
