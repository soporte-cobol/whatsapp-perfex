<?php
/**
 * Bridge de Emergencia - Superando bloqueos de CodeIgniter
 */
header('Content-Type: application/json; charset=utf-8');
define('BASEPATH', 'index.php');
define('FCPATH', __DIR__ . '/');
define('APPPATH', __DIR__ . '/application/');

if (!file_exists(__DIR__ . '/application/config/app-config.php')) {
    die(json_encode(['error' => 'No se encontró app-config.php']));
}
require_once(__DIR__ . '/application/config/app-config.php');

$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? '';
if (empty($received_token) && isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $received_token = str_ireplace('Bearer ', '', $_SERVER['HTTP_AUTHORIZATION']);
}

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido']));
}

$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
if (!$conn) die(json_encode(['error' => 'Error DB']));
mysqli_set_charset($conn, "utf8");

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$response = [];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $search10 = substr($phone, -10);
        $search7 = substr($phone, -7);
        
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$phone%' 
                   OR cl.phonenumber LIKE '%$phone%' 
                   OR c.phonenumber LIKE '%$search10%' 
                   OR c.phonenumber LIKE '%$search7%' 
                ORDER BY c.is_primary DESC LIMIT 1";
                
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false];
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' OR c.email LIKE '%$email%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false];
        break;

    case 'get_customer_by_vat':
        $vat = mysqli_real_escape_string($conn, trim($_GET['vat'] ?? ''));
        $sql = "SELECT userid as customerId, company, vat FROM tblclients WHERE vat LIKE '%$vat%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        if ($client = mysqli_fetch_assoc($res)) {
            $cid = $client['customerId'];
            $res_c = mysqli_query($conn, "SELECT id as contactId, firstname, lastname, email FROM tblcontacts WHERE userid = $cid ORDER BY is_primary DESC LIMIT 1");
            $contact = mysqli_fetch_assoc($res_c);
            $response = array_merge($client, $contact ? $contact : [], ['found' => true]);
        } else {
            $response = ['found' => false];
        }
        break;

    case 'get_invoices':
        $cid = intval($_GET['customer_id'] ?? 0);
        $res = mysqli_query($conn, "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid ORDER BY id DESC LIMIT 5");
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $response[] = $row;
        }
        break;

    case 'get_tickets':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $res = mysqli_query($conn, "SELECT ticketid, subject, status FROM tbltickets WHERE email = '$email' ORDER BY date DESC LIMIT 3");
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;

    case 'create_ticket':
        $post = json_decode(file_get_contents('php://input'), true);
        $subject = mysqli_real_escape_string($conn, $post['subject']);
        $message = mysqli_real_escape_string($conn, $post['message']);
        $priority = intval($post['priority'] ?? 2);
        $userid = intval($post['userid']);
        $contactid = intval($post['contactid']);
        $email = mysqli_real_escape_string($conn, $post['email']);
        $name = mysqli_real_escape_string($conn, $post['name']);
        $date = date('Y-m-d H:i:s');
        $ticketkey = md5(uniqid(rand(), true));

        $sql = "INSERT INTO tbltickets (userid, contactid, email, name, department, priority, status, subject, message, date, ticketkey) 
                VALUES ($userid, $contactid, '$email', '$name', 1, $priority, 1, '$subject', '$message', '$date', '$ticketkey')";
        
        if (mysqli_query($conn, $sql)) {
            $response = ['success' => true, 'ticketid' => mysqli_insert_id($conn)];
        } else {
            $response = ['success' => false, 'error' => mysqli_error($conn)];
        }
        break;
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
mysqli_close($conn);