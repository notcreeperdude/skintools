# SkinTools 🎮

A local web app to manage your CS2 storage units - move items in and out in bulk.

## Setup

1. Make sure you have **Node.js** installed (v14+)
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Open your browser to **http://localhost:3000**

## First Login

- Enter your Steam username and password
- If you have Steam Guard enabled, you'll be prompted for the code
- Your **refresh token** is saved locally (in `.refresh_token.json`) so you won't need to log in again next time

## What it does

- **View your inventory** - see all CS2 items in your Steam inventory
- **View storage unit contents** - select any of your storage units from the dropdown
- **Move items to storage** - select items in your inventory, click "Move to Storage"
- **Move items to inventory** - select items in the storage unit, click "Move to Inventory"
- **Bulk move** - select multiple items at once and move them all

## Notes

- You do NOT need CS2 installed - the app connects to the CS2 Game Coordinator directly
- No VAC ban risk - the app never connects to a VAC-secured server
- Nothing is sent to any third-party server - all communication is between your machine and Steam
- Run at your own risk

## Donations
If you find this useful, donations are appreciated! ❤️

- **BTC:** `bc1q79tzqcndpa4kjax4tha48wnqzqxcyewheluuhj`
- **XMR:** `88tNMYZnCXwC4kHctnv3CpE7B8ceUHNHEMRvai4QLvpAJpgB1x5SY1ABBmZKXyCAeijhmYjYtRee6SqHgVEJGWyuHhHBwi5`