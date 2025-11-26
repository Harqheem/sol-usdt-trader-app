// quickTest.js - Test everything and backfill your ADAUSDT trade
// Run with: node quickTest.js

require('dotenv').config();

async function runTests() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   LEARNING SYSTEM QUICK TEST           ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Test 1: Check if learningService exists
  console.log('Test 1: Loading learningService...');
  try {
    const learningService = require('./services/Trade Learning/learningService');
    console.log('✅ PASS - learningService loaded\n');

    // Test 2: Check database connection
    console.log('Test 2: Checking database connection...');
    const { supabase } = require('./services/logsService');
    
    const { error: tableError } = await supabase
      .from('learning_data')
      .select('id')
      .limit(1);
    
    if (tableError) {
      console.log('❌ FAIL - Database table error:', tableError.message);
      console.log('   → Run the SQL schema in Supabase to create learning_data table\n');
      return;
    }
    console.log('✅ PASS - Database table exists\n');

    // Test 3: Backfill ADAUSDT trade
    console.log('Test 3: Backfilling your ADAUSDT trade...');
    console.log('   Symbol: ADAUSDT');
    console.log('   Entry: $0.4195');
    console.log('   Exit: $0.4268');
    
    const entry = 0.4195;
    const exit = 0.4268;
    const pnlPct = ((exit - entry) / entry) * 100;
    console.log(`   P&L: ${pnlPct.toFixed(2)}%\n`);

    const result = await learningService.logSuccessfulTrade({
      symbol: 'ADAUSDT',
      direction: 'LONG',
      signalType: 'CVD_BULLISH_DIVERGENCE',
      signalSource: 'fast',
      entry: 0.4195,
      sl: 0.4158,
      tp1: 0.4232,
      tp2: 0.4268,
      exitPrice: 0.4268,
      pnl: pnlPct,
      closeReason: 'TP2',
      marketConditions: {
        regime: 'UNKNOWN',
        adx: null,
        rsi: null,
        trend: 'Unknown'
      },
      indicators: null
    });

    if (result && result.id) {
      console.log('✅ PASS - Trade logged successfully!');
      console.log(`   Entry ID: ${result.id}`);
      console.log(`   Type: ${result.type}`);
      console.log(`   Quality: ${result.quality || 'N/A'}`);
      console.log(`   Reason: ${result.reason}\n`);
    } else {
      console.log('❌ FAIL - No result returned\n');
      return;
    }

    // Test 4: Verify it's in database
    console.log('Test 4: Verifying entry in database...');
    const { data: entries, error: queryError } = await supabase
      .from('learning_data')
      .select('*')
      .eq('symbol', 'ADAUSDT')
      .order('timestamp', { ascending: false })
      .limit(1);

    if (queryError) {
      console.log('❌ FAIL - Query error:', queryError.message);
      return;
    }

    if (entries && entries.length > 0) {
      console.log('✅ PASS - Entry found in database!');
      console.log(`   ID: ${entries[0].id}`);
      console.log(`   Symbol: ${entries[0].symbol}`);
      console.log(`   Type: ${entries[0].type}`);
      console.log(`   P&L: ${entries[0].pnl_percentage?.toFixed(2)}%\n`);
    } else {
      console.log('❌ FAIL - Entry not found in database\n');
      return;
    }

    // Test 5: Check API endpoint
    console.log('Test 5: Testing API endpoint...');
    try {
      const fetch = require('node-fetch');
      const response = await fetch('http://localhost:3000/api/learning-data?limit=1');
      
      if (!response.ok) {
        console.log('❌ FAIL - API returned error:', response.status);
        console.log('   → Add API route to your index.js\n');
        return;
      }

      const apiData = await response.json();
      console.log('✅ PASS - API endpoint working!');
      console.log(`   Returned ${apiData.length} entries\n`);
    } catch (error) {
      console.log('⚠️  SKIP - Server not running or API not added');
      console.log('   → This is OK, just make sure to add API route\n');
    }

    // Final summary
    console.log('╔════════════════════════════════════════╗');
    console.log('║          TEST SUMMARY                  ║');
    console.log('╚════════════════════════════════════════╝\n');
    console.log('✅ Learning service loaded');
    console.log('✅ Database table exists');
    console.log('✅ ADAUSDT trade logged');
    console.log('✅ Entry verified in database\n');
    
    console.log('🎉 SUCCESS! Learning system is working!\n');
    console.log('Next steps:');
    console.log('1. Fix monitorService.js (move logging before return)');
    console.log('2. Add API route to index.js');
    console.log('3. Visit http://localhost:3000/learning.html\n');

  } catch (error) {
    console.log('❌ FAIL - Error during tests:', error.message);
    console.log('\nFull error:');
    console.error(error);
    console.log('\nTroubleshooting:');
    
    if (error.message.includes('Cannot find module')) {
      console.log('→ File path is wrong. Check folder structure:');
      console.log('  services/Trade Learning/learningService.js');
    } else if (error.message.includes('relation "learning_data" does not exist')) {
      console.log('→ Database table not created. Run SQL schema in Supabase.');
    } else if (error.message.includes('supabase')) {
      console.log('→ Supabase connection issue. Check .env file.');
    }
  }

  process.exit();
}

// Run the tests
runTests();