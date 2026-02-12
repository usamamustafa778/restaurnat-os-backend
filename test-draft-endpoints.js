/**
 * POS Draft API Test Script
 * 
 * This script tests all the POS draft endpoints to ensure they're working correctly.
 * 
 * Prerequisites:
 * 1. Server must be running (npm start or node server.js)
 * 2. You must have a valid JWT token
 * 3. You must have a valid tenant slug
 * 4. You must have at least one menu item in your restaurant
 * 
 * Usage:
 *   node test-draft-endpoints.js
 * 
 * Configuration:
 *   Edit the CONFIG section below with your credentials
 */

const axios = require('axios');

// ============================================
// CONFIGURATION - EDIT THESE VALUES
// ============================================
const CONFIG = {
  baseURL: 'http://localhost:5000',
  token: 'YOUR_JWT_TOKEN_HERE',              // Replace with your actual token
  tenantSlug: 'YOUR_TENANT_SLUG_HERE',       // Replace with your tenant slug
  branchId: null,                             // Optional: set to test branch filtering
  menuItemId: 'YOUR_MENU_ITEM_ID_HERE',      // Replace with an actual menu item ID
};

// ============================================
// TEST FUNCTIONS
// ============================================

const api = axios.create({
  baseURL: CONFIG.baseURL,
  headers: {
    'Authorization': `Bearer ${CONFIG.token}`,
    'x-tenant-slug': CONFIG.tenantSlug,
    'Content-Type': 'application/json',
  },
});

// Add branch header if provided
if (CONFIG.branchId) {
  api.defaults.headers['x-branch-id'] = CONFIG.branchId;
}

let createdDraftId = null;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  section: (msg) => console.log(`\n${colors.yellow}===${colors.reset} ${msg} ${colors.yellow}===${colors.reset}\n`),
};

// Test 1: Create a draft
async function testCreateDraft() {
  log.section('Test 1: Create Draft');
  
  try {
    const draftData = {
      items: [
        {
          menuItemId: CONFIG.menuItemId,
          name: 'Test Item',
          price: 49.99,
          quantity: 2,
          imageUrl: 'https://example.com/image.jpg',
        },
      ],
      orderType: 'DINE_IN',
      customerName: 'Test Customer',
      customerPhone: '+1234567890',
      subtotal: 99.98,
      total: 99.98,
      discountAmount: 0,
      tableNumber: '5',
      selectedWaiter: 'waiter_test',
    };

    const response = await api.post('/api/pos/drafts', draftData);
    
    if (response.status === 201 && response.data.id) {
      createdDraftId = response.data.id;
      log.success('Draft created successfully');
      log.info(`Draft ID: ${createdDraftId}`);
      log.info(`Reference Number: ${response.data.ref}`);
      log.info(`Total: ${response.data.total}`);
      return true;
    } else {
      log.error('Unexpected response structure');
      return false;
    }
  } catch (error) {
    log.error(`Failed to create draft: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 2: Get all drafts
async function testGetAllDrafts() {
  log.section('Test 2: Get All Drafts');
  
  try {
    const response = await api.get('/api/pos/drafts');
    
    if (response.status === 200 && Array.isArray(response.data)) {
      log.success(`Retrieved ${response.data.length} draft(s)`);
      
      if (response.data.length > 0) {
        const draft = response.data[0];
        log.info(`First draft ref: ${draft.ref}`);
        log.info(`Customer: ${draft.customerName || 'N/A'}`);
        log.info(`Total: ${draft.total}`);
      }
      
      return true;
    } else {
      log.error('Unexpected response structure');
      return false;
    }
  } catch (error) {
    log.error(`Failed to get drafts: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 3: Get specific draft
async function testGetDraft() {
  log.section('Test 3: Get Specific Draft');
  
  if (!createdDraftId) {
    log.error('No draft ID available (Test 1 may have failed)');
    return false;
  }
  
  try {
    const response = await api.get(`/api/pos/drafts/${createdDraftId}`);
    
    if (response.status === 200 && response.data.id === createdDraftId) {
      log.success('Draft retrieved successfully');
      log.info(`Ref: ${response.data.ref}`);
      log.info(`Customer: ${response.data.customerName}`);
      log.info(`Items: ${response.data.items.length}`);
      log.info(`Total: ${response.data.total}`);
      return true;
    } else {
      log.error('Unexpected response structure');
      return false;
    }
  } catch (error) {
    log.error(`Failed to get draft: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 4: Update draft
async function testUpdateDraft() {
  log.section('Test 4: Update Draft');
  
  if (!createdDraftId) {
    log.error('No draft ID available (Test 1 may have failed)');
    return false;
  }
  
  try {
    const updateData = {
      customerName: 'Updated Customer',
      total: 149.99,
      discountAmount: 10,
    };

    const response = await api.put(`/api/pos/drafts/${createdDraftId}`, updateData);
    
    if (response.status === 200 && response.data.id === createdDraftId) {
      log.success('Draft updated successfully');
      log.info(`New customer name: ${response.data.customerName}`);
      log.info(`New total: ${response.data.total}`);
      log.info(`Discount: ${response.data.discountAmount}`);
      return true;
    } else {
      log.error('Unexpected response structure');
      return false;
    }
  } catch (error) {
    log.error(`Failed to update draft: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 5: Delete draft
async function testDeleteDraft() {
  log.section('Test 5: Delete Draft');
  
  if (!createdDraftId) {
    log.error('No draft ID available (Test 1 may have failed)');
    return false;
  }
  
  try {
    const response = await api.delete(`/api/pos/drafts/${createdDraftId}`);
    
    if (response.status === 200) {
      log.success('Draft deleted successfully');
      log.info(`Message: ${response.data.message}`);
      
      // Verify deletion by trying to get the draft
      try {
        await api.get(`/api/pos/drafts/${createdDraftId}`);
        log.error('Draft still exists after deletion');
        return false;
      } catch (err) {
        if (err.response?.status === 404) {
          log.success('Verified: Draft no longer exists');
          return true;
        }
      }
    }
    
    return false;
  } catch (error) {
    log.error(`Failed to delete draft: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 6: Validation tests
async function testValidation() {
  log.section('Test 6: Validation Tests');
  
  let passed = 0;
  
  // Test empty items array
  try {
    await api.post('/api/pos/drafts', {
      items: [],
      subtotal: 0,
      total: 0,
    });
    log.error('Empty items array should be rejected');
  } catch (error) {
    if (error.response?.status === 400) {
      log.success('Empty items array correctly rejected');
      passed++;
    }
  }
  
  // Test missing required fields
  try {
    await api.post('/api/pos/drafts', {
      items: [{ menuItemId: CONFIG.menuItemId, name: 'Test', price: 10, quantity: 1 }],
      // Missing subtotal and total
    });
    log.error('Missing required fields should be rejected');
  } catch (error) {
    if (error.response?.status === 400) {
      log.success('Missing required fields correctly rejected');
      passed++;
    }
  }
  
  // Test invalid order type
  try {
    await api.post('/api/pos/drafts', {
      items: [{ menuItemId: CONFIG.menuItemId, name: 'Test', price: 10, quantity: 1 }],
      orderType: 'INVALID_TYPE',
      subtotal: 10,
      total: 10,
    });
    log.error('Invalid order type should be rejected');
  } catch (error) {
    if (error.response?.status === 400) {
      log.success('Invalid order type correctly rejected');
      passed++;
    }
  }
  
  log.info(`Validation tests passed: ${passed}/3`);
  return passed === 3;
}

// ============================================
// RUN ALL TESTS
// ============================================
async function runAllTests() {
  console.log('\n' + '='.repeat(60));
  console.log('POS DRAFT API TEST SUITE');
  console.log('='.repeat(60));
  
  // Check configuration
  if (CONFIG.token === 'YOUR_JWT_TOKEN_HERE' || CONFIG.tenantSlug === 'YOUR_TENANT_SLUG_HERE') {
    log.error('Please configure your JWT token and tenant slug in the CONFIG section');
    process.exit(1);
  }
  
  if (CONFIG.menuItemId === 'YOUR_MENU_ITEM_ID_HERE') {
    log.error('Please configure a valid menu item ID in the CONFIG section');
    process.exit(1);
  }
  
  const results = {
    passed: 0,
    failed: 0,
  };
  
  // Run tests sequentially
  const tests = [
    { name: 'Create Draft', fn: testCreateDraft },
    { name: 'Get All Drafts', fn: testGetAllDrafts },
    { name: 'Get Specific Draft', fn: testGetDraft },
    { name: 'Update Draft', fn: testUpdateDraft },
    { name: 'Delete Draft', fn: testDeleteDraft },
    { name: 'Validation Tests', fn: testValidation },
  ];
  
  for (const test of tests) {
    const result = await test.fn();
    if (result) {
      results.passed++;
    } else {
      results.failed++;
    }
  }
  
  // Summary
  log.section('Test Summary');
  console.log(`Total Tests: ${tests.length}`);
  console.log(`${colors.green}Passed: ${results.passed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${results.failed}${colors.reset}`);
  
  if (results.failed === 0) {
    console.log(`\n${colors.green}🎉 All tests passed!${colors.reset}\n`);
  } else {
    console.log(`\n${colors.red}❌ Some tests failed${colors.reset}\n`);
    process.exit(1);
  }
}

// Run the tests
runAllTests().catch((error) => {
  log.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
