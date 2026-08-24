# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> clears a Highroof request after takeover during a driver reconnect
- Location: tests/fare-flow-live.spec.js:393:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - img "My Ride Driver" [ref=e4]
    - generic [ref=e5]: My RideDRIVER
  - paragraph [ref=e6]: Driver Portal
  - generic [ref=e7]:
    - generic [ref=e8]:
      - button "Sign In" [ref=e9] [cursor=pointer]
      - button "Register" [ref=e10] [cursor=pointer]
    - generic [ref=e11]:
      - generic [ref=e12]:
        - generic [ref=e13]: Phone or Email
        - textbox "03001234567 or email" [ref=e14]
      - generic [ref=e15]:
        - generic [ref=e16]: Password
        - generic [ref=e17]:
          - textbox "••••••••" [ref=e18]
          - button "👁" [ref=e19] [cursor=pointer]
      - button "Sign In" [ref=e20] [cursor=pointer]
      - button "Forgot Password?" [ref=e22] [cursor=pointer]
```