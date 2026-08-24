# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> routes each Toyota category from the customer UI to only its matching driver
- Location: tests/fare-flow-live.spec.js:255:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e3]:
      - img "My Ride" [ref=e4]
      - generic [ref=e5]: My RideCUSTOMER
    - paragraph [ref=e6]: Customer Portal
    - generic [ref=e7]:
      - generic [ref=e8]:
        - button "Sign In" [ref=e9] [cursor=pointer]
        - button "Register" [ref=e10] [cursor=pointer]
      - generic [ref=e11]:
        - generic [ref=e12]:
          - generic [ref=e13]: Phone or Email
          - textbox "03001234567 or you@email.com" [ref=e14]
        - generic [ref=e15]:
          - generic [ref=e16]: Password
          - generic [ref=e17]:
            - textbox "••••••••" [ref=e18]
            - button "👁" [ref=e19] [cursor=pointer]
        - button "Sign In" [ref=e20] [cursor=pointer]
        - button "Forgot Password?" [ref=e22] [cursor=pointer]
  - generic:
    - generic:
      - button "← Back"
      - generic: 🆘 Emergency Contacts
      - generic: Saved contacts are included automatically in every SOS alert with your live location and driver details.
      - generic: Contact 1
      - generic:
        - generic: Name
        - textbox "e.g. Ammi"
      - generic:
        - generic: Phone
        - textbox "+92 300 0000000"
      - generic: Contact 2 (optional)
      - generic:
        - generic: Name
        - textbox "e.g. Bhai"
      - generic:
        - generic: Phone
        - textbox "+92 300 0000000"
      - generic:
        - button "Cancel"
        - button "Save Contacts"
```