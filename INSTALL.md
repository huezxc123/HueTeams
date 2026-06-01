# 🤖 Cuckoo AI — Installation Guide
## All 12 Gemini AI Features in 3 Steps

---

## STEP 1 — Get Your Free Gemini API Key

1. Go to https://aistudio.google.com/apikey
2. Click **"Create API Key"**
3. Copy your key (looks like: `AIzaSyXXXXXXXX...`)
4. Open `cuckoo-ai.js` and replace line 11:
   ```
   const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE';
   ```
   with:
   ```
   const GEMINI_API_KEY = 'AIzaSy...your actual key...';
   ```

---

## STEP 2 — Add to app.html

Open `app.html` and add ONE line just before the closing `</body>` tag:

```html
  <!-- Cuckoo AI Module -->
  <script src="cuckoo-ai.js"></script>
</body>
```

---

## STEP 3 — Add CSS to style.css

Open `style.css`, scroll to the very bottom, then paste the entire contents
of `cuckoo-ai.css` at the end.

---

## ✅ DONE! That's it.

Place both files (cuckoo-ai.js + cuckoo-ai.css) in the same folder as app.html.

---

## 🗺 WHERE EACH FEATURE APPEARS

| # | Feature | Where |
|---|---------|-------|
| 1 | Smart HR Chatbot | 🤖 floating button — bottom-right of every page |
| 2 | Payslip Explainer | "🤖 Explain" button inside payslip popup |
| 3 | Attendance Summarizer | "🤖 AI Summary" button in Attendance toolbar |
| 4 | Leave Balance Inquiry | "🤖 My Balance" button in Leaves page + chatbot |
| 5 | Policy Q&A | Dashboard → "📋 Policy Q&A" button + chatbot |
| 6 | Anomaly Detection | "🚨 Anomaly Scan" button in Attendance toolbar |
| 7 | Smart Shift Suggestions | Dashboard → "🗓 Suggest Shifts" (Admin only) |
| 8 | Leave Approval Draft | Auto-prompts after approving a leave |
| 9 | Performance Insights | Dashboard → "📈 Performance Query" (Admin only) |
| 10 | Onboarding Buddy | Dashboard → "🎉 Onboarding Guide" |
| 11 | Payroll Forecast | Dashboard → "🔮 Payroll Forecast" |
| 12 | Announcement Generator | Dashboard → "📢 Make Announcement" (Admin only) |

---

## 🏢 OPTIONAL — Add Company Policy Text

To enable Feature 5 (Policy Q&A) with YOUR actual company policy, save
the policy as plain text in Firebase under:

```
companies/{yourCompanyId}/settings/companyPolicy
```

Example value:
```
Our maternity leave policy allows 105 days paid leave per RA 11210.
Vacation leave is 15 days per year. Sick leave is 15 days per year.
Tardiness grace period is 5 minutes...
```

---

## 🎉 OPTIONAL — Add Onboarding Info

Save onboarding instructions in Firebase under:

```
companies/{yourCompanyId}/settings/onboardingInfo
```

Example:
```
Welcome! On your first day please submit: BIR 2316, SSS ID, PhilHealth number,
Pag-IBIG number, and 2x2 photo. Report to HR at 8:30 AM.
Wi-Fi password: cuckoo2025. Your buddy is Maria Santos.
```

---

## 🔒 SECURITY TIP

To prevent API key abuse, restrict your key in Google Cloud Console:
1. Go to https://console.cloud.google.com/apis/credentials
2. Click your API key
3. Under "API restrictions" → restrict to "Generative Language API"
4. Under "Website restrictions" → add your domain

---

## 💬 FREE TIER LIMITS

Gemini 2.0 Flash free tier:
- 1,500 requests/day
- 15 requests/minute
- Plenty for a small–medium HR team!
