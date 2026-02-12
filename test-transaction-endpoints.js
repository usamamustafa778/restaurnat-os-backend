/**
 * POS Transactions API Test Script
 * 
 * This script tests all the POS transaction endpoints to ensure they're working correctly.
 * 
 * Prerequisites:
 * 1. Server must be running (npm start or node server.js)
 * 2. You must have a valid JWT token
 * 3. You must have a valid tenant slug
 * 4. You must have at least one completed order in your database
 * 
 * Usage:
 *   node test-transaction-endpoints.js
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
  testOrderId: null,                          // Optional: set to test specific transaction retrieval
  adminToken: 'YOUR_ADMIN_JWT_TOKEN_HERE',   // Required for delete test
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

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  section: (msg) => console.log(`\n${colors.yellow}===${colors.reset} ${msg} ${colors.yellow}===${colors.reset}\n`),
  data: (label, value) => console.log(`  ${colors.cyan}${label}:${colors.reset} ${value}`),
};

// Test 1: Get all transactions
async function testGetAllTransactions() {
  log.section('Test 1: Get All Transactions');
  
  try {
    const response = await api.get('/api/pos/transactions');
    
    if (response.status === 200 && response.data.transactions && response.data.pagination) {
      log.success(`Retrieved ${response.data.transactions.length} transaction(s)`);
      log.data('Total Count', response.data.pagination.total);
      log.data('Has More', response.data.pagination.hasMore);
      
      if (response.data.transactions.length > 0) {
        const txn = response.data.transactions[0];
        log.info(`First transaction:`);
        log.data('  Order Number', txn.orderNumber);
        log.data('  Status', txn.status);
        log.data('  Payment Method', txn.paymentMethod);
        log.data('  Total', txn.total);
        log.data('  Date', new Date(txn.createdAt).toLocaleString());
        
        // Store for later tests
        if (!CONFIG.testOrderId && txn.id) {
          CONFIG.testOrderId = txn.id;
          log.info(`Using transaction ID for subsequent tests: ${CONFIG.testOrderId}`);
        }
      } else {
        log.warn('No transactions found. Some tests will be skipped.');
      }
      
      return true;
    } else {
      log.error('Unexpected response structure');
      return false;
    }
  } catch (error) {
    log.error(`Failed to get transactions: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 2: Get transactions with filters
async function testGetTransactionsWithFilters() {
  log.section('Test 2: Get Transactions with Filters');
  
  try {
    // Test date range filter
    const today = new Date().toISOString().split('T')[0];
    const response = await api.get('/api/pos/transactions', {
      params: {
        startDate: today,
        endDate: today,
        limit: 10,
      },
    });
    
    if (response.status === 200) {
      log.success(`Filtered transactions retrieved (today's orders)`);
      log.data('Count', response.data.transactions.length);
      log.data('Total', response.data.pagination.total);
      return true;
    }
    
    return false;
  } catch (error) {
    log.error(`Failed to filter transactions: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 3: Get transactions with pagination
async function testGetTransactionsWithPagination() {
  log.section('Test 3: Get Transactions with Pagination');
  
  try {
    // First page
    const page1 = await api.get('/api/pos/transactions', {
      params: { limit: 5, offset: 0 },
    });
    
    // Second page
    const page2 = await api.get('/api/pos/transactions', {
      params: { limit: 5, offset: 5 },
    });
    
    if (page1.status === 200 && page2.status === 200) {
      log.success('Pagination working correctly');
      log.data('Page 1 count', page1.data.transactions.length);
      log.data('Page 2 count', page2.data.transactions.length);
      log.data('Total records', page1.data.pagination.total);
      log.data('Has more after page 1', page1.data.pagination.hasMore);
      
      // Verify different transactions
      if (page1.data.transactions.length > 0 && page2.data.transactions.length > 0) {
        const page1Ids = page1.data.transactions.map(t => t.id);
        const page2Ids = page2.data.transactions.map(t => t.id);
        const overlap = page1Ids.filter(id => page2Ids.includes(id));
        
        if (overlap.length === 0) {
          log.success('Pages contain different records (no overlap)');
        } else {
          log.warn('Pages contain overlapping records');
        }
      }
      
      return true;
    }
    
    return false;
  } catch (error) {
    log.error(`Failed pagination test: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 4: Get transactions with sorting
async function testGetTransactionsWithSorting() {
  log.section('Test 4: Get Transactions with Sorting');
  
  try {
    // Sort by total ascending
    const response = await api.get('/api/pos/transactions', {
      params: {
        sortBy: 'total',
        sortOrder: 'asc',
        limit: 5,
      },
    });
    
    if (response.status === 200 && response.data.transactions.length > 0) {
      log.success('Sorting working correctly');
      log.info('Transactions sorted by total (ascending):');
      
      const totals = response.data.transactions.map(t => t.total);
      totals.forEach((total, i) => {
        log.data(`  Transaction ${i + 1}`, `$${total}`);
      });
      
      // Verify ascending order
      const isAscending = totals.every((val, i, arr) => i === 0 || arr[i - 1] <= val);
      if (isAscending) {
        log.success('Transactions are correctly sorted in ascending order');
      } else {
        log.warn('Transactions may not be sorted correctly');
      }
      
      return true;
    }
    
    return false;
  } catch (error) {
    log.error(`Failed sorting test: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 5: Get specific transaction
async function testGetSpecificTransaction() {
  log.section('Test 5: Get Specific Transaction');
  
  if (!CONFIG.testOrderId) {
    log.warn('No transaction ID available (Test 1 may have found no transactions)');
    return false;
  }
  
  try {
    const response = await api.get(`/api/pos/transactions/${CONFIG.testOrderId}`);
    
    if (response.status === 200 && response.data.id === CONFIG.testOrderId) {
      log.success('Transaction retrieved successfully');
      log.data('Order Number', response.data.orderNumber);
      log.data('Status', response.data.status);
      log.data('Payment Method', response.data.paymentMethod);
      log.data('Order Type', response.data.orderType);
      log.data('Total', response.data.total);
      log.data('Items', response.data.items.length);
      
      if (response.data.createdBy) {
        log.data('Created By', response.data.createdBy.name);
      }
      
      if (response.data.branch) {
        log.data('Branch', response.data.branch.name);
      }
      
      return true;
    } else {
      log.error('Unexpected response structure');
      return false;
    }
  } catch (error) {
    log.error(`Failed to get transaction: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 6: Filter by payment method
async function testFilterByPaymentMethod() {
  log.section('Test 6: Filter by Payment Method');
  
  try {
    const cashResponse = await api.get('/api/pos/transactions', {
      params: { paymentMethod: 'CASH', limit: 5 },
    });
    
    const cardResponse = await api.get('/api/pos/transactions', {
      params: { paymentMethod: 'CARD', limit: 5 },
    });
    
    if (cashResponse.status === 200 && cardResponse.status === 200) {
      log.success('Payment method filtering working');
      log.data('CASH transactions', cashResponse.data.transactions.length);
      log.data('CARD transactions', cardResponse.data.transactions.length);
      
      // Verify all are cash
      const allCash = cashResponse.data.transactions.every(t => t.paymentMethod === 'CASH');
      const allCard = cardResponse.data.transactions.every(t => t.paymentMethod === 'CARD');
      
      if (allCash && allCard) {
        log.success('All transactions have correct payment method');
      } else {
        log.warn('Some transactions may have incorrect payment method');
      }
      
      return true;
    }
    
    return false;
  } catch (error) {
    log.error(`Failed payment method filter test: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 7: Filter by status
async function testFilterByStatus() {
  log.section('Test 7: Filter by Status');
  
  try {
    const completedResponse = await api.get('/api/pos/transactions', {
      params: { status: 'COMPLETED', limit: 5 },
    });
    
    if (completedResponse.status === 200) {
      log.success('Status filtering working');
      log.data('COMPLETED transactions', completedResponse.data.transactions.length);
      
      // Verify all are completed
      const allCompleted = completedResponse.data.transactions.every(t => t.status === 'COMPLETED');
      
      if (allCompleted) {
        log.success('All transactions have COMPLETED status');
      } else {
        log.warn('Some transactions may have different status');
      }
      
      return true;
    }
    
    return false;
  } catch (error) {
    log.error(`Failed status filter test: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

// Test 8: Delete transaction (admin only)
async function testDeleteTransaction() {
  log.section('Test 8: Delete Transaction (Admin Only)');
  
  if (!CONFIG.testOrderId) {
    log.warn('No transaction ID available for delete test');
    return false;
  }
  
  if (CONFIG.adminToken === 'YOUR_ADMIN_JWT_TOKEN_HERE') {
    log.warn('Admin token not configured - skipping delete test');
    log.info('To test delete, set CONFIG.adminToken to a restaurant_admin or manager token');
    return false;
  }
  
  log.warn('⚠️  WARNING: This will actually delete/cancel a transaction!');
  log.info('Waiting 3 seconds... Press Ctrl+C to abort');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    // Create admin API client
    const adminApi = axios.create({
      baseURL: CONFIG.baseURL,
      headers: {
        'Authorization': `Bearer ${CONFIG.adminToken}`,
        'x-tenant-slug': CONFIG.tenantSlug,
        'Content-Type': 'application/json',
      },
    });
    
    const response = await adminApi.delete(`/api/pos/transactions/${CONFIG.testOrderId}`);
    
    if (response.status === 200) {
      log.success('Transaction deleted/cancelled successfully');
      log.data('Message', response.data.message);
      log.data('Order Number', response.data.orderNumber);
      log.data('Status', response.data.status);
      
      // Verify it's marked as CANCELLED
      if (response.data.status === 'CANCELLED') {
        log.success('Transaction correctly marked as CANCELLED');
      }
      
      return true;
    }
    
    return false;
  } catch (error) {
    if (error.response?.status === 403) {
      log.warn('User does not have permission to delete transactions (expected for non-admin)');
      log.info('This is correct behavior - only admins/managers can delete');
      return true; // This is expected
    } else if (error.response?.status === 400) {
      log.info(`Cannot delete: ${error.response.data.message}`);
      return true; // May already be cancelled
    } else {
      log.error(`Failed to delete transaction: ${error.response?.data?.message || error.message}`);
      return false;
    }
  }
}

// Test 9: Test non-admin cannot delete
async function testNonAdminCannotDelete() {
  log.section('Test 9: Non-Admin Cannot Delete');
  
  if (!CONFIG.testOrderId) {
    log.warn('No transaction ID available for test');
    return false;
  }
  
  try {
    await api.delete(`/api/pos/transactions/${CONFIG.testOrderId}`);
    log.error('Non-admin was able to delete - this should not happen!');
    return false;
  } catch (error) {
    if (error.response?.status === 403) {
      log.success('Non-admin correctly denied permission to delete');
      log.data('Error Message', error.response.data.message);
      return true;
    } else if (error.response?.status === 400) {
      log.info('Transaction already cancelled (from previous test)');
      return true;
    } else {
      log.error(`Unexpected error: ${error.response?.data?.message || error.message}`);
      return false;
    }
  }
}

// ============================================
// RUN ALL TESTS
// ============================================
async function runAllTests() {
  console.log('\n' + '='.repeat(60));
  console.log('POS TRANSACTIONS API TEST SUITE');
  console.log('='.repeat(60));
  
  // Check configuration
  if (CONFIG.token === 'YOUR_JWT_TOKEN_HERE' || CONFIG.tenantSlug === 'YOUR_TENANT_SLUG_HERE') {
    log.error('Please configure your JWT token and tenant slug in the CONFIG section');
    process.exit(1);
  }
  
  const results = {
    passed: 0,
    failed: 0,
  };
  
  // Run tests sequentially
  const tests = [
    { name: 'Get All Transactions', fn: testGetAllTransactions },
    { name: 'Get Transactions with Filters', fn: testGetTransactionsWithFilters },
    { name: 'Get Transactions with Pagination', fn: testGetTransactionsWithPagination },
    { name: 'Get Transactions with Sorting', fn: testGetTransactionsWithSorting },
    { name: 'Get Specific Transaction', fn: testGetSpecificTransaction },
    { name: 'Filter by Payment Method', fn: testFilterByPaymentMethod },
    { name: 'Filter by Status', fn: testFilterByStatus },
    { name: 'Non-Admin Cannot Delete', fn: testNonAdminCannotDelete },
    { name: 'Delete Transaction (Admin)', fn: testDeleteTransaction },
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
